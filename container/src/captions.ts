// Pure caption helpers: language selection, subtitle file matching and VTT
// parsing. Kept apart from index.ts so they can be unit tested (`bun test`).

export interface SubtitleInfo {
	language: string | null;
	subtitles: Record<string, unknown[]>;
	automatic_captions: Record<string, unknown[]>;
}

export interface SelectedLanguage {
	lang: string;
	isManual: boolean;
}

// Parse VTT content to plain text
export function parseVTT(content: string): string {
	const lines = content.split("\n");
	const textLines: string[] = [];
	let inCue = false;

	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "");
		const trimmed = line.trim();

		// Only a truly empty line ends a cue (WebVTT). YouTube auto-captions
		// put a line holding a single space right after the timestamp of a
		// cue that starts after a pause, followed by the spoken text; treating
		// that space as the end of the cue dropped the text, and on shorts
		// where every cue looks like this the whole transcript came out empty.
		if (line === "") {
			inCue = false;
			continue;
		}
		if (trimmed === "") continue;

		// Skip header lines
		if (
			!inCue &&
			(trimmed === "WEBVTT" ||
				trimmed.startsWith("Kind:") ||
				trimmed.startsWith("Language:"))
		) {
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
		if (inCue) {
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

// Get the base language code (e.g. "pt-BR" -> "pt", "zh-Hans" -> "zh")
export function baseLangCode(lang: string): string {
	return lang.split("-")[0];
}

export const ORIG_SUFFIX = "-orig";

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
export function findOriginalAutoLang(
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
export function selectLanguagePriorities(
	info: SubtitleInfo,
): SelectedLanguage[] {
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

// The yt-dlp language keys to request for one selected caption track, best
// first. Each entry is a regex, as `--sub-lang` takes them (comma-separated,
// matched against the whole key).
//
// An original-speech key's spelling is not stable between yt-dlp runs: yt-dlp
// builds it from the caption track's `vssId` ("a.en" -> "en-orig", "a.en-US"
// -> "en-US-orig"), and two extractions of the same video (the listing, then
// the download) can get different player responses. When the listing said
// "en-US-orig" and the download run only had "en-orig", yt-dlp wrote no file
// and the request failed with "No subtitles available for language:
// en-US-orig". Asking for both spellings of the same original track fixes
// that; they are the same speech, never a translation.
export function subtitleLangAliases(lang: string): string[] {
	if (!lang.endsWith(ORIG_SUFFIX)) return [escapeRegex(lang)];
	const spoken = lang.slice(0, -ORIG_SUFFIX.length);
	const base = baseLangCode(spoken);
	if (spoken !== base) {
		// "en-US-orig" -> also "en-orig"
		return [escapeRegex(lang), escapeRegex(`${base}${ORIG_SUFFIX}`)];
	}
	// "en-orig" -> also any regional spelling such as "en-US-orig"
	return [
		escapeRegex(lang),
		`${escapeRegex(base)}-[A-Za-z0-9]+${escapeRegex(ORIG_SUFFIX)}`,
	];
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Language key of a file yt-dlp wrote as "<id>.<lang>.vtt" with
// `-o <dir>/%(id)s`, or null for any other name.
export function subtitleFileLang(
	fileName: string,
	videoId: string,
): string | null {
	const prefix = `${videoId}.`;
	if (!fileName.startsWith(prefix) || !fileName.endsWith(".vtt")) return null;
	const lang = fileName.slice(prefix.length, -".vtt".length);
	return lang || null;
}

// Pick the written subtitle file for the requested aliases (best alias
// first). Matching is on the exact language key, so "en" never picks up an
// "en-orig" or "en-GB" file.
export function pickSubtitleFile(
	fileNames: string[],
	videoId: string,
	aliases: string[],
): { file: string; lang: string } | null {
	const written = fileNames
		.map((file) => ({ file, lang: subtitleFileLang(file, videoId) }))
		.filter((f): f is { file: string; lang: string } => f.lang !== null)
		.sort((a, b) => a.file.localeCompare(b.file));
	for (const alias of aliases) {
		const re = new RegExp(`^(?:${alias})$`);
		const match = written.find((f) => re.test(f.lang));
		if (match) return match;
	}
	return null;
}
