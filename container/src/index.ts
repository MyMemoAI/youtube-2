import { $ } from "bun";
import { Hono } from "hono";

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

// Type definitions for yt-dlp subtitle info
interface SubtitleInfo {
	language: string | null;
	subtitles: Record<string, unknown[]>;
	automatic_captions: Record<string, unknown[]>;
}

interface VideoMetadata {
	description: string;
	view_count: number;
	author: string;
}

interface VideoInfo extends SubtitleInfo {
	metadata: VideoMetadata;
}

interface SelectedLanguage {
	lang: string;
	isManual: boolean;
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

// Parse VTT content to plain text
function parseVTT(content: string): string {
	const lines = content.split("\n");
	const textLines: string[] = [];
	let inCue = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip header and empty lines
		if (
			trimmed === "WEBVTT" ||
			trimmed === "" ||
			trimmed.startsWith("Kind:") ||
			trimmed.startsWith("Language:")
		) {
			inCue = false;
			continue;
		}

		// Skip timestamp lines (contain -->)
		if (trimmed.includes("-->")) {
			inCue = true;
			continue;
		}

		// Skip cue identifiers (numeric or NOTE lines)
		if (/^\d+$/.test(trimmed) || trimmed.startsWith("NOTE")) {
			continue;
		}

		// Collect text content
		if (inCue && trimmed) {
			// Remove VTT tags like <c>, </c>, <v speaker>, etc.
			const cleanText = trimmed
				.replace(/<[^>]+>/g, "") // Remove HTML-like tags
				.replace(/&nbsp;/g, " ")
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.trim();

			if (cleanText) {
				textLines.push(cleanText);
			}
		}
	}

	// Deduplicate consecutive identical lines (common in auto-subs)
	const deduplicated = textLines.filter(
		(line, index) => index === 0 || line !== textLines[index - 1],
	);

	return deduplicated.join("\n");
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
		await $`${YT_DLP} ${YT_DLP_COMMON_ARGS} --print ${"%(.{language,subtitles,automatic_captions,description,view_count,uploader})#j"} ${url}`
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
	};
}

// Get the base language code (e.g. "pt-BR" -> "pt", "zh-Hans" -> "zh")
function baseLangCode(lang: string): string {
	return lang.split("-")[0];
}

const ORIG_SUFFIX = "-orig";

// Find the auto-caption key for the video's original speech.
//
// YouTube lists one "<lang>-orig" key per audio track: the speech recognised
// in that track, untranslated. The plain "<lang>" key can instead be a machine
// translation of another track: on an auto-dubbed English video, "en" was
// `lang=ar&tlang=en` (English translated from the Arabic dub's captions) while
// "en-orig" was `lang=en` with no `tlang`. YouTube rate-limits translated
// tracks hard (HTTP 429, yt-dlp issue #13831), so asking for "en" failed on
// every dubbed video. Dubbed videos list several "-orig" keys, so match the
// video's own language; without one, only a lone "-orig" key is unambiguous.
function findOriginalAutoLang(
	autoLangs: string[],
	originalLang: string | null,
): string | undefined {
	const origLangs = autoLangs.filter((l) => l.endsWith(ORIG_SUFFIX));
	if (originalLang) {
		const exact = `${originalLang}${ORIG_SUFFIX}`;
		if (origLangs.includes(exact)) return exact;
		const base = baseLangCode(originalLang);
		const sameBase = origLangs.find(
			(l) => baseLangCode(l.slice(0, -ORIG_SUFFIX.length)) === base,
		);
		if (sameBase) return sameBase;
	}
	return origLangs.length === 1 ? origLangs[0] : undefined;
}

// Find a language key matching a locale (e.g. "pt-BR" matches "pt")
// Skips "-orig" suffixed keys (handled separately)
function findMatchingLang(langs: string[], target: string): string | undefined {
	// Exact match first
	if (langs.includes(target)) return target;
	// Base language match, but skip "-orig" keys
	const base = baseLangCode(target);
	return langs.find((l) => l === base && !l.endsWith("-orig"));
}

// Select available languages in priority order (best first)
function selectLanguagePriorities(info: SubtitleInfo): SelectedLanguage[] {
	const { language: originalLang, subtitles, automatic_captions } = info;

	// Filter out non-language entries like "live_chat" that YouTube returns for live streams
	const invalidLangs = ["live_chat"];
	const manualLangs = Object.keys(subtitles).filter(
		(l) => !invalidLangs.includes(l),
	);
	const autoLangs = Object.keys(automatic_captions).filter(
		(l) => !invalidLangs.includes(l),
	);

	const results: SelectedLanguage[] = [];
	const seen = new Set<string>();

	const add = (lang: string, isManual: boolean) => {
		const key = `${lang}:${isManual}`;
		if (!seen.has(key)) {
			seen.add(key);
			results.push({ lang, isManual });
		}
	};

	// Priority 1: Manual in original language
	if (originalLang) {
		const match = findMatchingLang(manualLangs, originalLang);
		if (match) add(match, true);
	}
	// Priority 2: Manual in English
	const enManual = manualLangs.find((l) => l.startsWith("en"));
	if (enManual) add(enManual, true);

	// Priority 3: Any manual
	for (const l of manualLangs) add(l, true);

	// Priority 4: Auto in the original speech ("<lang>-orig", never a
	// translation). Listings without "-orig" keys fall back to the base code
	// (e.g. "pt-BR" -> "pt").
	const originalAuto = findOriginalAutoLang(autoLangs, originalLang);
	if (originalAuto) {
		add(originalAuto, false);
	} else if (originalLang) {
		const base = baseLangCode(originalLang);
		if (autoLangs.includes(base)) add(base, false);
	}
	// Priority 5: Auto in English, the untranslated track when there is one
	if (autoLangs.includes(`en${ORIG_SUFFIX}`)) {
		add(`en${ORIG_SUFFIX}`, false);
	} else if (
		autoLangs.some(
			(l) => l === "en" || (l.startsWith("en-") && !l.endsWith(ORIG_SUFFIX)),
		)
	) {
		add("en", false);
	}

	// Priority 6: Any remaining untranslated auto track, then the rest
	for (const l of autoLangs) if (l.endsWith(ORIG_SUFFIX)) add(l, false);
	for (const l of autoLangs) add(l, false);

	return results;
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

// Find subtitle file in output directory
async function findSubtitleFile(
	outputDir: string,
	videoId: string,
	lang: string,
): Promise<{ path: string; type: "manual" | "auto" } | null> {
	const glob = new Bun.Glob(`${videoId}.${lang}*.vtt`);
	const files: string[] = [];

	for await (const file of glob.scan(outputDir)) {
		files.push(file);
	}

	// Prefer manual subtitles (no .auto. in filename)
	const manualSub = files.find((f) => !f.includes(".auto."));
	if (manualSub) {
		return { path: `${outputDir}/${manualSub}`, type: "manual" };
	}

	// Fall back to auto-generated
	const autoSub = files.find((f) => f.includes(".auto."));
	if (autoSub) {
		return { path: `${outputDir}/${autoSub}`, type: "auto" };
	}

	return null;
}

// Find any subtitle file in output directory (language-agnostic)
async function findAnySubtitleFile(
	outputDir: string,
	videoId: string,
): Promise<{ path: string; type: "manual" | "auto"; lang: string } | null> {
	const glob = new Bun.Glob(`${videoId}.*.vtt`);
	const files: string[] = [];

	for await (const file of glob.scan(outputDir)) {
		files.push(file);
	}

	if (files.length === 0) return null;

	// Extract language from filename: {videoId}.{lang}.vtt or {videoId}.{lang}.auto.vtt
	const extractLang = (f: string) => {
		const withoutId = f.replace(`${videoId}.`, "");
		return withoutId.replace(/\.auto\.vtt$/, "").replace(/\.vtt$/, "");
	};

	const manualSub = files.find((f) => !f.includes(".auto."));
	if (manualSub) {
		return {
			path: `${outputDir}/${manualSub}`,
			type: "manual",
			lang: extractLang(manualSub),
		};
	}

	const autoSub = files[0];
	return {
		path: `${outputDir}/${autoSub}`,
		type: "auto",
		lang: extractLang(autoSub),
	};
}

// Try downloading subtitle for a specific language
async function tryDownloadSubtitle(
	url: string,
	videoId: string,
	targetLang: string,
): Promise<{
	transcript: string;
	subtitleType: "manual" | "auto";
}> {
	const outputDir = `/tmp/subs/${videoId}_${Date.now()}`;
	await $`mkdir -p ${outputDir}`;

	try {
		const result =
			await $`${YT_DLP} ${YT_DLP_COMMON_ARGS} --write-sub --write-auto-sub --sub-lang ${targetLang} --sub-format vtt -o ${`${outputDir}/%(id)s`} ${url}`
				.nothrow()
				.quiet();

		if (result.exitCode !== 0) {
			const stderr = result.stderr.toString();
			throw parseYtDlpError(stderr);
		}

		const subtitleFile = await findSubtitleFile(outputDir, videoId, targetLang);
		if (!subtitleFile) {
			throw new TranscriptError(
				`No subtitles available for language: ${targetLang}`,
				"NO_SUBTITLES",
				404,
			);
		}

		const subtitleContent = await Bun.file(subtitleFile.path).text();
		const transcript = parseVTT(subtitleContent);

		if (!transcript.trim()) {
			throw new TranscriptError("Transcript is empty", "NO_SUBTITLES", 404);
		}

		// yt-dlp names "-orig" auto captions without the ".auto." marker
		return {
			transcript,
			subtitleType: targetLang.endsWith(ORIG_SUFFIX)
				? "auto"
				: subtitleFile.type,
		};
	} finally {
		await $`rm -rf ${outputDir}`.nothrow();
	}
}

// Download the original auto-generated subtitle using the video's original language
async function tryDownloadOriginalSubtitle(
	url: string,
	videoId: string,
	originalLang: string,
	originalAutoLang: string | undefined,
): Promise<{
	transcript: string;
	subtitleType: "manual" | "auto";
	detectedLanguage: string;
}> {
	const outputDir = `/tmp/subs/${videoId}_${Date.now()}`;
	await $`mkdir -p ${outputDir}`;

	// The untranslated "<lang>-orig" track when listed, else the base code
	// (e.g. "pt-BR" -> "pt")
	const subLang = originalAutoLang ?? baseLangCode(originalLang);

	try {
		const result =
			await $`${YT_DLP} ${YT_DLP_COMMON_ARGS} --write-auto-sub --sub-lang ${subLang} --sub-format vtt -o ${`${outputDir}/%(id)s`} ${url}`
				.nothrow()
				.quiet();

		if (result.exitCode !== 0) {
			const stderr = result.stderr.toString();
			throw parseYtDlpError(stderr);
		}

		const subtitleFile = await findAnySubtitleFile(outputDir, videoId);
		if (!subtitleFile) {
			throw new TranscriptError(
				"No auto-generated subtitles available",
				"NO_SUBTITLES",
				404,
			);
		}

		const subtitleContent = await Bun.file(subtitleFile.path).text();
		const transcript = parseVTT(subtitleContent);

		if (!transcript.trim()) {
			throw new TranscriptError("Transcript is empty", "NO_SUBTITLES", 404);
		}

		return {
			transcript,
			subtitleType: subLang.endsWith(ORIG_SUFFIX) ? "auto" : subtitleFile.type,
			detectedLanguage: subtitleFile.lang,
		};
	} finally {
		await $`rm -rf ${outputDir}`.nothrow();
	}
}

// Download and parse transcript
async function downloadAndParseTranscript(
	url: string,
	lang?: string,
): Promise<{
	transcript: string;
	videoId: string;
	subtitleType: "manual" | "auto";
	detectedLanguage: string;
	wasAutoDetected: boolean;
	availableLanguages?: string[];
	metadata: VideoMetadata;
}> {
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
		throw new TranscriptError(
			"No subtitles available for this video",
			"NO_SUBTITLES",
			404,
		);
	}

	// Try top priority languages first (max 2 to stay within timeout budget)
	const maxAttempts = Math.min(priorities.length, 2);
	let lastError: TranscriptError | undefined;
	for (let i = 0; i < maxAttempts; i++) {
		const selected = priorities[i];
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
				lastError = error;
				continue;
			}
			throw error;
		}
	}

	// Last resort: download using the video's original language directly.
	// Auto-translated subtitles hit YouTube's translation API which is aggressively rate-limited,
	// but the original language subtitle is pre-generated and more likely to succeed.
	try {
		const result = await tryDownloadOriginalSubtitle(
			url,
			videoId,
			subtitleInfo.language ?? "en",
			findOriginalAutoLang(
				Object.keys(subtitleInfo.automatic_captions),
				subtitleInfo.language,
			),
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
		// If this also fails, throw the original rate limit error
		throw (
			lastError ??
			(error instanceof TranscriptError
				? error
				: new TranscriptError(
						"No subtitles available for this video",
						"NO_SUBTITLES",
						404,
					))
		);
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

	try {
		console.log({ message: "Downloading transcript" });
		// Subtitle info, transcript and video metadata now share one budget
		// because metadata comes from the same yt-dlp invocation as the
		// subtitle listing (previously 60s transcript + 30s metadata).
		const result = await withTimeout(
			downloadAndParseTranscript(url, lang),
			90000, // 90 second timeout
			"Transcript download timed out",
		);
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
				error.statusCode as 400 | 403 | 404 | 429 | 500 | 504,
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
	idleTimeout: 120, // 120 seconds to handle slow yt-dlp operations
};
