// Error class for transcript-specific errors
export class TranscriptError extends Error {
	constructor(
		message: string,
		public code: string,
		public statusCode: number = 500,
	) {
		super(message);
		this.name = "TranscriptError";
	}
}

// YouTube's own words from yt-dlp's "ERROR: [youtube] <id>: <reason>" line,
// without yt-dlp's advice to pass cookies, which MyMemo never does.
function youtubeReason(stderr: string): string {
	const line =
		stderr.split("\n").find((l) => l.startsWith("ERROR:")) ??
		stderr.trim().split("\n")[0] ??
		"";
	return line
		.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, "")
		.replace(/\s*Use --cookies.*$/, "")
		.trim();
}

// Parse yt-dlp error output
//
// Status codes decide what happens next, so the order of the checks matters:
// - The Worker retries 429, 5xx and a 403 whose body says "sign in" or "not a
//   bot" on another container instance; mymemo-service retries the same
//   (`_classify_youtube_failure`). Any other 4xx is answered at once.
// - mymemo-service counts a YOUTUBE_WORKER 403 or 404 as the site refusing
//   (src/platform/save_failure_causes.py) and anything else as a MyMemo
//   failure, so refusals must not fall through to the 500 at the end.
// The refusals come before the 429 check because that check matches "429"
// anywhere, and a video ID can contain it.
//
// MyMemo never works around a refusal: no cookies, accounts, proxies or VPNs.
export function parseYtDlpError(stderr: string): TranscriptError {
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
	// The uploader limited the video to some countries. yt-dlp adds the
	// countries and a suggestion to use a VPN or proxy; only the countries are
	// kept. "Your country" is where the container runs, not where the member
	// is, so the message does not say it. Not retried: every container
	// instance is refused the same way. The message must not say "sign in" or
	// "not a bot", or the Worker and mymemo-service would retry it.
	if (
		/not made this video available in your country/i.test(stderr) ||
		/not available from your location/i.test(stderr)
	) {
		const listed = stderr
			.match(/This video is available in ([^\n]+?)\.?$/m)?.[1]
			.split(", ");
		const countries =
			listed && listed.length > 8
				? `${listed.slice(0, 8).join(", ")} and ${listed.length - 8} more`
				: listed?.join(", ");
		return new TranscriptError(
			`The uploader has made this video available only in some countries, and MyMemo cannot read it from where its servers are.${countries ? ` YouTube lists it as available in ${countries}.` : ""}`,
			"GEO_BLOCKED",
			403,
		);
	}
	if (stderr.includes("Private video")) {
		return new TranscriptError(
			`Video is private or requires authentication: ${youtubeReason(stderr)}`,
			"ACCESS_DENIED",
			403,
		);
	}
	// YouTube's bot check. It has read "Sign in to confirm you're not a bot"
	// and, lowercase, "Please sign in. This helps protect our community" (yt-dlp
	// drops the second sentence when YouTube ends it with "Learn more"). The
	// message keeps "sign in", so the Worker and mymemo-service retry it on
	// another container instance as they did before.
	if (
		/not a bot|please sign in|protect our community|captcha challenge/i.test(
			stderr,
		)
	) {
		return new TranscriptError(
			`YouTube's bot protection asked MyMemo to sign in, so it could not read this video: ${youtubeReason(stderr)}`,
			"BOT_CHECK",
			403,
		);
	}
	// Any other video YouTube shows only to signed-in viewers, such as
	// age-restricted ones ("Sign in to confirm your age").
	if (/sign in/i.test(stderr)) {
		return new TranscriptError(
			`Video is private or requires authentication: ${youtubeReason(stderr)}`,
			"ACCESS_DENIED",
			403,
		);
	}
	// "Join this channel to get access to members-only content like this
	// video, and other exclusive perks."
	if (/join this channel|members-only content/i.test(stderr)) {
		return new TranscriptError(
			`This video is only for the channel's paying members: ${youtubeReason(stderr)}`,
			"MEMBERS_ONLY",
			403,
		);
	}
	if (stderr.includes("429") || stderr.includes("Too Many Requests")) {
		return new TranscriptError(
			`Rate limited by YouTube: ${stderr.trim()}`,
			"RATE_LIMITED",
			429,
		);
	}
	// Everything else, including YouTube's own "We're experiencing technical
	// difficulties." and yt-dlp failures such as "No video formats found!",
	// stays a 500 so the Worker retries it on another container instance.
	return new TranscriptError(`yt-dlp error: ${stderr.trim()}`, "UNKNOWN", 500);
}
