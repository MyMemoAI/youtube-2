import { $ } from "bun";
import { Hono } from "hono";
import {
	baseLangCode,
	findOriginalAutoLang,
	ORIG_SUFFIX,
	parseVTT,
	pickSubtitleFile,
	type SubtitleInfo,
	selectLanguagePriorities,
	subtitleLangAliases,
} from "./captions";

const app = new Hono();

const YT_DLP = "/usr/local/bin/yt-dlp";

// Flags shared by every yt-dlp invocation.
//
// --extractor-args youtube:player_client=default,-web
//   The default clients are `tv_samsung,visionos,web` (yt-dlp 2026.10.21 README,
//   "EXTRACTOR ARGUMENTS" > youtube > player_client), so this runs
//   `tv_samsung,visionos`; `tv_samsung` needs the JavaScript runtime (deno,
//   installed by the Dockerfile) and is skipped without one. The `web` client
//   is the one that carries WEB_PO_TOKEN_POLICIES and needs a JS challenge solve, and it is the
//   client that produces "Sign in to confirm you're not a bot" from datacenter
//   IPs without cookies/PO tokens. `visionos` requires no PO token and sets
//   REQUIRE_JS_PLAYER=False, and yt-dlp still falls back to `tv_downgraded` /
//   `web_embedded` on its own when `visionos` cannot access a video. The `-`
//   exclusion prefix is documented in the same README section.
// --extractor-args youtube:skip=hls,dash
//   "One or more of `hls`, `dash` or `translated_subs` to skip extraction of the
//   m3u8 manifests, dash manifests ... respectively" (same README section). We
//   never download media, so these manifest requests are pure extra load and
//   extra bot-check surface. `translated_subs` is deliberately NOT skipped: an
//   explicit `lang` request may legitimately resolve to a translated track.
// --socket-timeout 20 / --retries 3 / --extractor-retries 2
//   "Time to wait before giving up, in seconds" / "Number of retries (default is
//   10)" / "Number of retries for known extractor errors (default is 3)"
//   (yt-dlp --help). The defaults can burn the whole request budget on a single
//   stuck socket; the Worker retries on a different container instance instead.
const YT_DLP_COMMON_ARGS = [
	"--sleep-requests",
	"1",
	"--socket-timeout",
	"20",
	"--retries",
	"3",
	"--extractor-retries",
	"2",
	"--extractor-args",
	"youtube:player_client=default,-web;skip=hls,dash",
	"--no-playlist",
	"--no-warnings",
	"--skip-download",
];

interface VideoMetadata {
	description: string;
	view_count: number;
	author: string;
}

interface VideoInfo extends SubtitleInfo {
	metadata: VideoMetadata;
	duration: number | null;
	liveStatus: string | null;
}

interface TranscriptResult {
	transcript: string;
	videoId: string;
	subtitleType: "manual" | "auto" | "asr";
	detectedLanguage: string;
	wasAutoDetected: boolean;
	availableLanguages?: string[];
	metadata: VideoMetadata;
}

// Error class for transcript-specific errors
class TranscriptError extends Error {
	constructor(
		message: string,
		public code: string,
		public statusCode: number = 500,
	) {
		super(message);
		this.name = "TranscriptError";
	}
}

// The video has no usable caption track: it lists none in any language, or
// every listed track came back missing or empty. Same code and messages as
// before, so the response is unchanged when audio transcription is off; it
// carries the listing for the audio fallback in the /transcript handler.
class NoCaptionTracksError extends TranscriptError {
	constructor(
		public videoId: string,
		public info: VideoInfo,
		message = "No subtitles available for this video",
		// What was tried before giving up on captions, for the log
		public tried: string[] = [],
	) {
		super(message, "NO_SUBTITLES", 404);
		this.name = "NoCaptionTracksError";
	}
}

// A track that yt-dlp did not write, or that held no text. Anything else
// (rate limit, bot check, unavailable video, timeout) is not "missing".
function isMissingCaption(error: unknown): error is TranscriptError {
	return error instanceof TranscriptError && error.code === "NO_SUBTITLES";
}

// Validate YouTube URL
function isValidYouTubeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const validHosts = [
			"youtube.com",
			"www.youtube.com",
			"m.youtube.com",
			"youtu.be",
			"www.youtu.be",
		];
		return validHosts.some(
			(host) =>
				parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
		);
	} catch {
		return false;
	}
}

// Extract video ID from YouTube URL
function extractVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);

		// Handle youtu.be short URLs
		if (parsed.hostname.includes("youtu.be")) {
			return parsed.pathname.slice(1).split("/")[0] || null;
		}

		// Handle youtube.com/watch URLs
		if (parsed.pathname === "/watch") {
			return parsed.searchParams.get("v");
		}

		// Handle /v/, /embed/, /shorts/, /live/ URLs
		const pathMatch = parsed.pathname.match(
			/^\/(v|embed|shorts|live)\/([^/?]+)/,
		);
		if (pathMatch) {
			return pathMatch[2];
		}

		return null;
	} catch {
		return null;
	}
}

// Parse yt-dlp error output
function parseYtDlpError(stderr: string): TranscriptError {
	// yt-dlp phrases this as both "Video unavailable" and "This video is
	// unavailable" depending on the client that produced the error, so match
	// case-insensitively on both. Getting this right matters because the Worker
	// retries 5xx on another container instance; a genuinely missing video must
	// map to 404 so it is not retried.
	if (
		/video (is )?unavailable/i.test(stderr) ||
		stderr.includes("is not a valid URL") ||
		stderr.includes("Incomplete YouTube ID")
	) {
		return new TranscriptError(
			`Video not found: ${stderr.trim()}`,
			"VIDEO_NOT_FOUND",
			404,
		);
	}
	if (stderr.includes("429") || stderr.includes("Too Many Requests")) {
		return new TranscriptError(
			`Rate limited by YouTube: ${stderr.trim()}`,
			"RATE_LIMITED",
			429,
		);
	}
	if (stderr.includes("Private video") || stderr.includes("Sign in")) {
		return new TranscriptError(
			`Video is private or requires authentication: ${stderr.trim()}`,
			"ACCESS_DENIED",
			403,
		);
	}
	return new TranscriptError(`yt-dlp error: ${stderr.trim()}`, "UNKNOWN", 500);
}

// Fetch subtitle availability *and* video metadata in a single yt-dlp
// invocation. Each invocation is an independent extraction (and therefore an
// independent chance of being bot-checked or rate-limited), so the previously
// separate `getAvailableSubtitles` and `getVideoMetadata` calls are merged into
// one `--print` template.
async function getVideoInfo(url: string): Promise<VideoInfo> {
	const result =
		await $`${YT_DLP} ${YT_DLP_COMMON_ARGS} --print ${"%(.{language,subtitles,automatic_captions,description,view_count,uploader,duration,live_status})#j"} ${url}`
			.nothrow()
			.quiet();

	if (result.exitCode !== 0) {
		throw parseYtDlpError(result.stderr.toString());
	}

	const output = result.stdout.toString().trim();
	const data = JSON.parse(output);

	return {
		language: data.language ?? null,
		subtitles: data.subtitles ?? {},
		automatic_captions: data.automatic_captions ?? {},
		metadata: {
			description: data.description ?? "",
			view_count: data.view_count ?? 0,
			author: data.uploader ?? "",
		},
		duration: typeof data.duration === "number" ? data.duration : null,
		liveStatus: data.live_status ?? null,
	};
}

// Timeout wrapper
async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	errorMessage: string,
): Promise<T> {
	const timeout = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new TranscriptError(errorMessage, "TIMEOUT", 504)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]);
}

// Download one caption track and parse it. `aliases` are the `--sub-lang`
// regexes for that track, best first (see subtitleLangAliases). Throws
// NO_SUBTITLES with `missingMessage` when yt-dlp wrote no matching file (it
// exits 0 when the requested language is not in its listing), and
// "Transcript is empty" when the file held no text.
async function downloadCaption(
	url: string,
	videoId: string,
	aliases: string[],
	missingMessage: string,
	autoOnly = false,
): Promise<{ transcript: string; lang: string }> {
	const outputDir = `/tmp/subs/${videoId}_${Date.now()}`;
	await $`mkdir -p ${outputDir}`;
	const writeFlags = autoOnly
		? ["--write-auto-sub"]
		: ["--write-sub", "--write-auto-sub"];

	try {
		const result =
			await $`${YT_DLP} ${YT_DLP_COMMON_ARGS} ${writeFlags} --sub-lang ${aliases.join(",")} --sub-format vtt -o ${`${outputDir}/%(id)s`} ${url}`
				.nothrow()
				.quiet();

		if (result.exitCode !== 0) {
			const stderr = result.stderr.toString();
			throw parseYtDlpError(stderr);
		}

		const files: string[] = [];
		for await (const file of new Bun.Glob("*.vtt").scan(outputDir)) {
			files.push(file);
		}
		const picked = pickSubtitleFile(files, videoId, aliases);
		if (!picked) {
			throw new TranscriptError(missingMessage, "NO_SUBTITLES", 404);
		}

		const subtitleContent = await Bun.file(
			`${outputDir}/${picked.file}`,
		).text();
		const transcript = parseVTT(subtitleContent);

		if (!transcript.trim()) {
			throw new TranscriptError("Transcript is empty", "NO_SUBTITLES", 404);
		}

		return { transcript, lang: picked.lang };
	} finally {
		await $`rm -rf ${outputDir}`.nothrow();
	}
}

// yt-dlp writes manual and automatic captions under the same name, so only
// the "-orig" (always automatic) keys are known to be auto here.
function subtitleTypeOf(lang: string): "manual" | "auto" {
	return lang.endsWith(ORIG_SUFFIX) ? "auto" : "manual";
}

// Try a specific language
async function tryDownloadSubtitle(
	url: string,
	videoId: string,
	targetLang: string,
): Promise<{
	transcript: string;
	subtitleType: "manual" | "auto";
}> {
	const { transcript, lang } = await downloadCaption(
		url,
		videoId,
		subtitleLangAliases(targetLang),
		`No subtitles available for language: ${targetLang}`,
	);
	return { transcript, subtitleType: subtitleTypeOf(lang) };
}

// Download the original auto-generated subtitle using the video's original language
async function tryDownloadOriginalSubtitle(
	url: string,
	videoId: string,
	subLang: string,
): Promise<{
	transcript: string;
	subtitleType: "manual" | "auto";
	detectedLanguage: string;
}> {
	const { transcript, lang } = await downloadCaption(
		url,
		videoId,
		subtitleLangAliases(subLang),
		"No auto-generated subtitles available",
		true,
	);
	return {
		transcript,
		subtitleType: subtitleTypeOf(lang),
		detectedLanguage: lang,
	};
}

// Caption tracks tried in priority order before the original-language
// fallback. Each try is one yt-dlp run (typically 5-20 s); together with the
// listing and the fallback that is at most 4 runs, all inside the 90 s
// caption budget of the /transcript handler.
const MAX_CAPTION_ATTEMPTS = 2;

// Download and parse transcript
async function downloadAndParseTranscript(
	url: string,
	lang?: string,
): Promise<TranscriptResult> {
	const videoId = extractVideoId(url);
	if (!videoId) {
		throw new TranscriptError(
			"Could not extract video ID: this is not a single video link (channel and playlist pages have no transcript). Save the link of one video instead.",
			"INVALID_URL",
			400,
		);
	}

	// Single yt-dlp invocation for both subtitle availability and video metadata.
	const subtitleInfo = await getVideoInfo(url);
	const { metadata } = subtitleInfo;

	// When a specific language is requested, try it directly (no fallback)
	if (lang && lang !== "auto") {
		const { transcript, subtitleType } = await tryDownloadSubtitle(
			url,
			videoId,
			lang,
		);
		return {
			transcript,
			videoId,
			subtitleType,
			detectedLanguage: lang,
			wasAutoDetected: false,
			metadata,
		};
	}

	// Auto-detection: try languages in priority order
	const availableLanguages = Array.from(
		new Set([
			...Object.keys(subtitleInfo.subtitles),
			...Object.keys(subtitleInfo.automatic_captions),
		]),
	);

	const priorities = selectLanguagePriorities(subtitleInfo);
	if (priorities.length === 0) {
		throw new NoCaptionTracksError(videoId, subtitleInfo);
	}

	// A track that is missing or empty moves on to the next one. A rate limit
	// also moves on but is remembered: it is what the request answers with if
	// nothing else works, so the Worker retries on another instance. Any other
	// error (bot check, unavailable video) ends the request as before.
	let rateLimited: TranscriptError | undefined;
	let firstMissing: TranscriptError | undefined;
	const missingLangs = new Set<string>();
	const tried: string[] = [];

	for (const selected of priorities.slice(0, MAX_CAPTION_ATTEMPTS)) {
		tried.push(selected.lang);
		try {
			const { transcript, subtitleType } = await tryDownloadSubtitle(
				url,
				videoId,
				selected.lang,
			);
			return {
				transcript,
				videoId,
				subtitleType,
				detectedLanguage: selected.lang,
				wasAutoDetected: true,
				availableLanguages,
				metadata,
			};
		} catch (error) {
			if (error instanceof TranscriptError && error.code === "RATE_LIMITED") {
				rateLimited = error;
				continue;
			}
			if (isMissingCaption(error)) {
				console.warn({
					message: "Caption track unusable; trying the next one",
					videoId,
					lang: selected.lang,
					error: error.message,
				});
				firstMissing ??= error;
				missingLangs.add(selected.lang);
				continue;
			}
			throw error;
		}
	}

	// Last resort: download using the video's original language directly.
	// Auto-translated subtitles hit YouTube's translation API which is aggressively rate-limited,
	// but the original language subtitle is pre-generated and more likely to succeed.
	// The untranslated "<lang>-orig" track when listed, else the base code
	// (e.g. "pt-BR" -> "pt"). Skipped when that track already came back
	// missing or empty above: the same run would only repeat it.
	const originalSubLang =
		findOriginalAutoLang(
			Object.keys(subtitleInfo.automatic_captions),
			subtitleInfo.language,
		) ?? baseLangCode(subtitleInfo.language ?? "en");
	if (!missingLangs.has(originalSubLang)) {
		tried.push(`${originalSubLang} (original)`);
		try {
			const result = await tryDownloadOriginalSubtitle(
				url,
				videoId,
				originalSubLang,
			);
			return {
				transcript: result.transcript,
				videoId,
				subtitleType: result.subtitleType,
				detectedLanguage: result.detectedLanguage,
				wasAutoDetected: true,
				availableLanguages,
				metadata,
			};
		} catch (error) {
			if (error instanceof TranscriptError && error.code === "RATE_LIMITED") {
				throw error;
			}
			if (!isMissingCaption(error)) {
				// Throw the earlier rate limit error, if any
				throw (
					rateLimited ??
					(error instanceof TranscriptError
						? error
						: new TranscriptError(
								"No subtitles available for this video",
								"NO_SUBTITLES",
								404,
							))
				);
			}
			firstMissing ??= error;
		}
	}

	// Rate-limit handling is unchanged: answer 429 so the Worker retries.
	if (rateLimited) throw rateLimited;

	// Every listed track tried was missing or empty: treat the video like one
	// without captions, so the /transcript handler transcribes its audio.
	throw new NoCaptionTracksError(
		videoId,
		subtitleInfo,
		firstMissing?.message,
		tried,
	);
}

// Speech-to-text fallback for videos that list no caption track at all
// (about 170 saves a month in production in October 2026: mostly languages
// YouTube does not auto-caption and uploads with captions turned off). The
// audio is cut into 5-minute chunks and sent to Cloudflare Workers AI
// Whisper, the model mymemo-service uses for uploaded audio. It runs only when
// the Worker passes CF_API_TOKEN and CF_ACCOUNT_ID into the container.
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

// Measured 2026-10-25: Whisper takes 18-26 s for a 5-minute chunk and 238 s
// for one 43-minute request, so long audio has to go out in parallel chunks.
const ASR_CHUNK_SECONDS = 300;
const ASR_CONCURRENCY = 10;
const ASR_MAX_DURATION_SECONDS = 2 * 60 * 60;
const WHISPER_MAX_ATTEMPTS = 3;

// The whole /transcript request, caption listing included, has to answer
// within this: the Worker still looks up the title afterwards, and
// mymemo-service gives the Worker 300 s. Below Bun's 255 s idleTimeout too.
const ASR_DEADLINE_MS = 220_000;

interface WhisperEndpoint {
	url: string;
	token: string;
}

interface WhisperResponse {
	result?: {
		text?: string;
		transcription_info?: { language?: string };
	};
}

function whisperEndpoint(): WhisperEndpoint | null {
	const token = process.env.CF_API_TOKEN;
	const accountId = process.env.CF_ACCOUNT_ID;
	if (!token || !accountId) return null;
	return {
		url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${WHISPER_MODEL}`,
		token,
	};
}

// 424 rather than 5xx: the Worker and mymemo-service both retry 5xx, and each
// retry would download and transcribe the whole video again, past their
// time limits.
function transcriptionFailed(detail: string): TranscriptError {
	return new TranscriptError(
		`This video has no captions, and transcribing its audio failed: ${detail}`,
		"TRANSCRIPTION_FAILED",
		424,
	);
}

// Bun's `$` cannot be cancelled, so the fallback spawns directly: when the
// deadline passes, yt-dlp and ffmpeg are killed instead of running on.
async function runCommand(
	cmd: string[],
	signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", signal });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	signal.throwIfAborted();
	return { exitCode, stdout, stderr };
}

// Download the smallest Opus audio-only format, else the smallest audio
// (`-S +abr` ranks the lowest audio bitrate best): about 50 kbps, plenty for
// speech recognition.
async function downloadAudio(
	url: string,
	dir: string,
	signal: AbortSignal,
): Promise<string> {
	const args = YT_DLP_COMMON_ARGS.filter((arg) => arg !== "--skip-download");
	const result = await runCommand(
		[
			YT_DLP,
			...args,
			"-f",
			"ba[acodec=opus]/ba/b",
			"-S",
			"+abr",
			"--max-filesize",
			"300M",
			// Replays of recent live streams come as hundreds of small DASH
			// fragments: 6 minutes for 50 minutes of audio one at a time, 36 s
			// with 16 in parallel. No effect on ordinary single-file formats.
			"--concurrent-fragments",
			"16",
			"-o",
			`${dir}/audio.%(ext)s`,
			"--print",
			"after_move:filepath",
			"--no-simulate",
			url,
		],
		signal,
	);
	if (result.exitCode !== 0) {
		throw parseYtDlpError(result.stderr);
	}
	const path = result.stdout.trim().split("\n").pop();
	if (!path) {
		throw transcriptionFailed("yt-dlp downloaded no audio");
	}
	return path;
}

// Cut into chunks without re-encoding (~1.9 MB per 5 minutes). Re-encoding to
// 16 kHz mono took 9-12 s per 10 minutes of audio on half a CPU (standard-1)
// and did not make Whisper faster. YouTube's webm audio is Opus, which goes
// into Ogg; AAC goes into m4a. `-t` bounds the work when yt-dlp reported no
// duration.
async function splitAudio(
	input: string,
	dir: string,
	signal: AbortSignal,
): Promise<string[]> {
	const ext = input.endsWith(".webm") ? "ogg" : "m4a";
	const result = await runCommand(
		[
			"ffmpeg",
			"-nostdin",
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			input,
			"-map",
			"0:a:0",
			"-c",
			"copy",
			"-t",
			String(ASR_MAX_DURATION_SECONDS),
			"-f",
			"segment",
			"-segment_time",
			String(ASR_CHUNK_SECONDS),
			`${dir}/chunk%03d.${ext}`,
		],
		signal,
	);
	if (result.exitCode !== 0) {
		throw transcriptionFailed(`ffmpeg: ${result.stderr.trim().slice(0, 300)}`);
	}
	const chunks: string[] = [];
	for await (const file of new Bun.Glob("chunk*").scan(dir)) {
		chunks.push(`${dir}/${file}`);
	}
	if (chunks.length === 0) {
		throw transcriptionFailed("ffmpeg produced no audio");
	}
	return chunks.sort();
}

// No `language` is sent: these videos report none, and the uploader's declared
// language would force Whisper to that language even when it is wrong. Whisper
// detects it per chunk; `vad_filter` skips music and silence, where Whisper
// otherwise invents text.
async function transcribeChunk(
	endpoint: WhisperEndpoint,
	path: string,
	signal: AbortSignal,
): Promise<{ text: string; language: string | null }> {
	const audio = Buffer.from(await Bun.file(path).arrayBuffer()).toString(
		"base64",
	);
	const body = JSON.stringify({ audio, vad_filter: true });
	for (let attempt = 1; ; attempt++) {
		let status = 0;
		let detail: string;
		try {
			const response = await fetch(endpoint.url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${endpoint.token}`,
					"Content-Type": "application/json",
				},
				body,
				signal,
			});
			if (response.ok) {
				const data = (await response.json()) as WhisperResponse;
				return {
					text: (data.result?.text ?? "").trim(),
					language: data.result?.transcription_info?.language ?? null,
				};
			}
			status = response.status;
			detail = (await response.text()).slice(0, 300);
		} catch (error) {
			signal.throwIfAborted();
			detail = error instanceof Error ? error.message : String(error);
		}
		const retryable = status === 0 || status === 429 || status >= 500;
		if (!retryable || attempt >= WHISPER_MAX_ATTEMPTS) {
			throw transcriptionFailed(
				`Whisper ${status ? `HTTP ${status}` : "request failed"}: ${detail}`,
			);
		}
		await Bun.sleep(attempt * 2000);
	}
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await fn(items[index]);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

async function transcribeVideoAudio(
	url: string,
	videoId: string,
	info: VideoInfo,
	endpoint: WhisperEndpoint,
	deadline: number,
): Promise<TranscriptResult> {
	if (info.liveStatus === "is_live" || info.liveStatus === "is_upcoming") {
		throw new TranscriptError(
			"This live stream or premiere has not ended yet, so it has no captions. Save it again after it ends.",
			"NO_SUBTITLES",
			404,
		);
	}
	if (info.duration !== null && info.duration > ASR_MAX_DURATION_SECONDS) {
		throw new TranscriptError(
			`This video has no captions, and at ${Math.round(info.duration / 60)} minutes it is longer than the ${ASR_MAX_DURATION_SECONDS / 60}-minute limit for transcribing its audio.`,
			"NO_SUBTITLES",
			404,
		);
	}

	const budgetMs = Math.max(deadline - Date.now(), 1);
	const timeout = AbortSignal.timeout(budgetMs);
	const failure = new AbortController();
	const signal = AbortSignal.any([timeout, failure.signal]);
	const dir = `/tmp/asr/${videoId}_${Date.now()}`;
	await $`mkdir -p ${dir}`;

	try {
		const startedAt = Date.now();
		const audioPath = await downloadAudio(url, dir, signal);
		const downloadedAt = Date.now();
		const chunks = await splitAudio(audioPath, dir, signal);
		const splitAt = Date.now();
		const results = await mapWithConcurrency(chunks, ASR_CONCURRENCY, (chunk) =>
			transcribeChunk(endpoint, chunk, signal),
		).catch((error) => {
			// Stop the chunks still in flight.
			failure.abort();
			throw error;
		});

		const transcript = results
			.map((r) => r.text)
			.filter(Boolean)
			.join("\n");
		console.log({
			message: "Transcribed audio",
			videoId,
			duration: info.duration,
			chunks: chunks.length,
			downloadMs: downloadedAt - startedAt,
			splitMs: splitAt - downloadedAt,
			whisperMs: Date.now() - splitAt,
			characters: transcript.length,
		});
		if (!transcript) {
			throw new TranscriptError(
				"This video has no captions, and no speech was found in its audio.",
				"NO_SUBTITLES",
				404,
			);
		}

		return {
			transcript,
			videoId,
			subtitleType: "asr",
			detectedLanguage:
				results.find((r) => r.text && r.language)?.language ?? "",
			wasAutoDetected: true,
			availableLanguages: [],
			metadata: info.metadata,
		};
	} catch (error) {
		if (timeout.aborted) {
			throw transcriptionFailed(
				`it did not finish within ${Math.round(budgetMs / 1000)} seconds`,
			);
		}
		throw error;
	} finally {
		await $`rm -rf ${dir}`.nothrow();
	}
}

// Health check endpoint
app.get("/", (c) => c.json({ status: "ok" }));

// Transcript endpoint
app.get("/transcript", async (c) => {
	const url = c.req.query("url");
	const langParam = c.req.query("lang");
	// Treat "auto" or undefined as auto-detection mode
	const lang = langParam === "auto" ? undefined : langParam;

	// Validate URL presence
	if (!url) {
		return c.json(
			{ success: false, error: "URL is required", code: "INVALID_URL" },
			400,
		);
	}

	// Validate YouTube URL
	if (!isValidYouTubeUrl(url)) {
		return c.json(
			{ success: false, error: "Invalid YouTube URL", code: "INVALID_URL" },
			400,
		);
	}

	const startedAt = Date.now();
	try {
		console.log({ message: "Downloading transcript" });
		let result: TranscriptResult;
		try {
			// Subtitle info, transcript and video metadata now share one budget
			// because metadata comes from the same yt-dlp invocation as the
			// subtitle listing (previously 60s transcript + 30s metadata).
			result = await withTimeout(
				downloadAndParseTranscript(url, lang),
				90000, // 90 second timeout
				"Transcript download timed out",
			);
		} catch (error) {
			const endpoint = whisperEndpoint();
			if (!(error instanceof NoCaptionTracksError) || !endpoint) {
				throw error;
			}
			console.log({
				message: "No usable caption tracks; transcribing the audio",
				videoId: error.videoId,
				triedTracks: error.tried,
				duration: error.info.duration,
				liveStatus: error.info.liveStatus,
			});
			result = await transcribeVideoAudio(
				url,
				error.videoId,
				error.info,
				endpoint,
				startedAt + ASR_DEADLINE_MS,
			);
		}
		console.log({ message: "Downloading transcript", result });

		return c.json({
			success: true,
			transcript: result.transcript,
			metadata: {
				videoId: result.videoId,
				subtitleType: result.subtitleType,
				language: result.detectedLanguage,
				wasAutoDetected: result.wasAutoDetected,
				availableLanguages: result.availableLanguages,
				description: result.metadata.description,
				view_count: result.metadata.view_count,
				author: result.metadata.author,
			},
		});
	} catch (error) {
		if (error instanceof TranscriptError) {
			return c.json(
				{ success: false, error: error.message, code: error.code },
				error.statusCode as 400 | 403 | 404 | 424 | 429 | 500 | 504,
			);
		}
		console.error("Unexpected error:", error);
		return c.json(
			{ success: false, error: "Internal server error", code: "UNKNOWN" },
			500,
		);
	}
});

export default {
	fetch: app.fetch,
	// Bun's maximum; the audio fallback answers within ASR_DEADLINE_MS
	idleTimeout: 255,
};
