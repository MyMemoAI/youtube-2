import { describe, expect, test } from "bun:test";
import { parseYtDlpError } from "../src/errors";

// yt-dlp's login hint (`_login_hint(method="cookies")` plus
// `_youtube_login_hint`), appended to every YouTube reason that says "sign in".
const COOKIE_HINT =
	"Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies. Also see  https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies  for tips on effectively exporting YouTube cookies";

// What the Worker (src/index.ts isRetryableContainerFailure) and
// mymemo-service (_YOUTUBE_BOT_CHECK_MARKERS) look for in a 403 body to retry
// it on another container instance.
const RETRIED_403 = /sign in|not a bot/i;

describe("parseYtDlpError: refusals are 403, never 500", () => {
	test("lowercase 'Please sign in' (production, 2026-11-23) is LOGIN_REQUIRED, not retried", () => {
		// Same text from a residential IP on 2026-11-24, where other videos
		// played: the video needs a sign-in, wherever it is read from.
		const error = parseYtDlpError(
			`ERROR: [youtube] JBe3GwtlJ6Q: Please sign in. This helps protect our community. ${COOKIE_HINT}\n`,
		);
		expect(error.statusCode).toBe(403);
		expect(error.code).toBe("LOGIN_REQUIRED");
		expect(error.message).toBe(
			"YouTube shows this video only to signed-in viewers, and MyMemo never signs in to YouTube, so it could not read it.",
		);
		expect(error.message).not.toMatch(RETRIED_403);
	});

	test("'Please sign in' after yt-dlp dropped 'This helps protect our community. Learn more'", () => {
		const error = parseYtDlpError(
			`ERROR: [youtube] JBe3GwtlJ6Q: Please sign in. ${COOKIE_HINT}\n`,
		);
		expect(error.statusCode).toBe(403);
		expect(error.code).toBe("LOGIN_REQUIRED");
	});

	test("age-restricted video is LOGIN_REQUIRED, not retried", () => {
		const error = parseYtDlpError(
			`ERROR: [youtube] abcdefghijk: Sign in to confirm your age. This video may be inappropriate for some users. ${COOKIE_HINT}\n`,
		);
		expect(error.statusCode).toBe(403);
		expect(error.code).toBe("LOGIN_REQUIRED");
		expect(error.message).toContain("age-restricted");
		expect(error.message).not.toMatch(RETRIED_403);
	});

	test("bot check 'Sign in to confirm you're not a bot' stays 403 and retried", () => {
		const error = parseYtDlpError(
			`ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. This helps protect our community. ${COOKIE_HINT}\n`,
		);
		expect(error.statusCode).toBe(403);
		expect(error.code).toBe("BOT_CHECK");
		expect(error.message).not.toContain("--cookies");
		// Retried on another container instance, as it always was.
		expect(error.message).toMatch(RETRIED_403);
	});

	test("captcha challenge is a bot check, retried", () => {
		// yt-dlp appends this sentence to YouTube's reason when the player
		// response carries a captcha (yt_dlp/extractor/youtube/_video.py).
		const error = parseYtDlpError(
			"ERROR: [youtube] dQw4w9WgXcQ: Something went wrong. YouTube is requiring a captcha challenge before playback\n",
		);
		expect(error.statusCode).toBe(403);
		expect(error.code).toBe("BOT_CHECK");
		expect(error.message).toMatch(RETRIED_403);
	});

	test("geo-block (production, 2026-11-19)", () => {
		const error = parseYtDlpError(
			"ERROR: [youtube] qT-urhn-glQ: The uploader has not made this video available in your country\nThis video is available in Austria, Switzerland, Germany, Liechtenstein, Luxembourg.\nYou might want to use a VPN or a proxy server (with --proxy) to workaround.\n",
		);
		expect(error.statusCode).toBe(403);
		expect(error.code).toBe("GEO_BLOCKED");
		expect(error.message).toBe(
			"The uploader has made this video available only in some countries, and MyMemo cannot read it from where its servers are. YouTube lists it as available in Austria, Switzerland, Germany, Liechtenstein, Luxembourg.",
		);
		// Answered at once: the Worker and mymemo-service do not retry it.
		expect(error.message).not.toMatch(RETRIED_403);
		expect(error.message).not.toMatch(/VPN|proxy|your country/i);
	});

	test("geo-block without a country list, and with a long one", () => {
		const bare = parseYtDlpError(
			"ERROR: [youtube] qT-urhn-glQ: The uploader has not made this video available in your country\nYou might want to use a VPN or a proxy server (with --proxy) to workaround.\n",
		);
		expect(bare.code).toBe("GEO_BLOCKED");
		expect(bare.message).not.toContain("lists it");

		// yt-dlp's full names can contain the separator ("Korea, Republic of").
		const many = [
			"Korea, Republic of",
			...Array.from({ length: 30 }, (_, i) => `Country${i}`),
		].join(", ");
		const long = parseYtDlpError(
			`ERROR: [youtube] qT-urhn-glQ: The uploader has not made this video available in your country\nThis video is available in ${many}.\n`,
		);
		expect(long.message).toContain(
			"available in Korea, Republic of, Country0, Country1,",
		);
		expect(long.message).toEndWith(" and others.");
		expect(long.message).not.toContain("Country29");
		// mymemo-service keeps the first 240 characters.
		expect(long.message.length).toBeLessThan(240);
	});

	test("a video ID containing 429 does not turn a refusal into a rate limit", () => {
		const error = parseYtDlpError(
			"ERROR: [youtube] ab429cdEfGh: The uploader has not made this video available in your country\n",
		);
		expect(error.code).toBe("GEO_BLOCKED");
		expect(error.statusCode).toBe(403);
	});

	test("private video is 403 ACCESS_DENIED, not retried", () => {
		const error = parseYtDlpError(
			`ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access to this video. ${COOKIE_HINT}\n`,
		);
		expect(error.statusCode).toBe(403);
		expect(error.code).toBe("ACCESS_DENIED");
		// mymemo-service files it as youtube_private by this phrase.
		expect(error.message.toLowerCase()).toContain("video is private");
		expect(error.message).not.toMatch(RETRIED_403);
	});

	test.each([
		// DQXH88Jpc6k from a residential IP on 2026-11-24 (production read
		// "We're experiencing technical difficulties." on 11-21)
		"ERROR: [youtube] DQXH88Jpc6k: This video is available to this channel's members on level: 위캔두 Premium (or any higher level). Join this channel to get access to members-only content and other exclusive perks.\n",
		"ERROR: [youtube] abcdefghijk: Join this channel to get access to members-only content like this video, and other exclusive perks.\n",
	])("members-only video is 403 MEMBERS_ONLY, not retried: %s", (stderr) => {
		const error = parseYtDlpError(stderr);
		expect(error.statusCode).toBe(403);
		expect(error.code).toBe("MEMBERS_ONLY");
		// mymemo-service files it as youtube_members_only by this phrase.
		expect(error.message.toLowerCase()).toContain("join this channel");
		expect(error.message).not.toMatch(RETRIED_403);
	});
});

describe("parseYtDlpError: unchanged outcomes", () => {
	test("removed video stays 404", () => {
		const error = parseYtDlpError(
			"ERROR: [youtube] abcdefghijk: Video unavailable. This video has been removed by the uploader\n",
		);
		expect(error.statusCode).toBe(404);
		expect(error.code).toBe("VIDEO_NOT_FOUND");
	});

	test("HTTP 429 stays 429", () => {
		const error = parseYtDlpError(
			"ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests\n",
		);
		expect(error.statusCode).toBe(429);
		expect(error.code).toBe("RATE_LIMITED");
	});

	test.each([
		// YouTube-side and transient (production, 2026-11-21)
		"ERROR: [youtube] DQXH88Jpc6k: We're experiencing technical difficulties.\n",
		// Outdated yt-dlp (production, 2026-11-19 and 11-21)
		"ERROR: [youtube] Dl1lY6eYAxQ: No video formats found!; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U\n",
		"ERROR: Did not get any data blocks\n",
	])("%s stays a retryable 500", (stderr) => {
		const error = parseYtDlpError(stderr);
		expect(error.statusCode).toBe(500);
		expect(error.code).toBe("UNKNOWN");
	});
});
