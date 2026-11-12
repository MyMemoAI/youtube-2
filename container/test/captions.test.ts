import { describe, expect, test } from "bun:test";
import {
	findOriginalAutoLang,
	parseVTT,
	pickSubtitleFile,
	selectLanguagePriorities,
	subtitleFileLang,
	subtitleLangAliases,
} from "../src/captions";

const listing = (langs: string[]) =>
	Object.fromEntries(langs.map((l) => [l, [{ ext: "vtt" }]]));

describe("parseVTT", () => {
	test("keeps text after a whitespace-only line (YouTube auto-captions after a pause)", () => {
		// Shape of the auto-captions of a short that came back "Transcript is
		// empty": every cue starts after a pause, so each one has a line
		// holding a single space before its text.
		const vtt = [
			"WEBVTT",
			"Kind: captions",
			"Language: en",
			"",
			"00:00:08.240 --> 00:00:27.500 align:start position:0%",
			" ",
			"It's<00:00:08.320><c> okay.</c>",
			"",
			"00:00:27.500 --> 00:00:27.510 align:start position:0%",
			" ",
			" ",
			"",
			"00:00:27.510 --> 00:00:35.360 align:start position:0%",
			" ",
			"&gt;&gt; [music]",
			"",
		].join("\n");
		expect(parseVTT(vtt)).toBe("It's okay.\n>> [music]");
	});

	test("rolling auto-captions come out once per line", () => {
		const vtt = [
			"WEBVTT",
			"Kind: captions",
			"Language: en",
			"",
			"00:00:00.160 --> 00:00:02.270 align:start position:0%",
			" ",
			"hello<00:00:00.480><c> world</c>",
			"",
			"00:00:02.270 --> 00:00:02.280 align:start position:0%",
			"hello world",
			" ",
			"",
			"00:00:02.280 --> 00:00:05.000 align:start position:0%",
			"hello world",
			"next<00:00:03.000><c> line</c>",
			"",
			"00:00:05.000 --> 00:00:05.010 align:start position:0%",
			"next line",
			" ",
			"",
		].join("\n");
		expect(parseVTT(vtt)).toBe("hello world\nnext line");
	});

	test("manual captions with cue ids and CRLF", () => {
		const vtt =
			"WEBVTT\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.000\r\nFirst &amp; one\r\n\r\n2\r\n00:00:02.000 --> 00:00:03.000\r\n<v Bob>Second</v>\r\n";
		expect(parseVTT(vtt)).toBe("First & one\nSecond");
	});

	test("a file with only blank cues is empty", () => {
		const vtt =
			"WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:01.000\n \n \n";
		expect(parseVTT(vtt)).toBe("");
	});
});

describe("selectLanguagePriorities", () => {
	test("auto-dubbed en-US video listed with en-orig picks en-orig first", () => {
		// Listing of a failing production video as seen locally
		// (language en-US, no manual tracks, several dubbed "-orig" tracks).
		const priorities = selectLanguagePriorities({
			language: "en-US",
			subtitles: {},
			automatic_captions: listing(["ar-orig", "en", "en-orig", "fr-orig"]),
		});
		expect(priorities.slice(0, 2)).toEqual([
			{ lang: "en-orig", isManual: false },
			{ lang: "ar-orig", isManual: false },
		]);
	});

	test("listing with en-US-orig picks it first", () => {
		const priorities = selectLanguagePriorities({
			language: "en-US",
			subtitles: {},
			automatic_captions: listing(["en-US-orig", "en-US", "en", "fr-orig"]),
		});
		expect(priorities[0]).toEqual({ lang: "en-US-orig", isManual: false });
	});

	test("manual track in the original language comes first", () => {
		const priorities = selectLanguagePriorities({
			language: "en-US",
			subtitles: listing(["en-US", "live_chat"]),
			automatic_captions: listing(["en-orig", "en"]),
		});
		expect(priorities[0]).toEqual({ lang: "en-US", isManual: true });
		expect(priorities.some((p) => p.lang === "live_chat")).toBe(false);
	});

	test("no tracks gives no priorities", () => {
		expect(
			selectLanguagePriorities({
				language: null,
				subtitles: {},
				automatic_captions: {},
			}),
		).toEqual([]);
	});
});

describe("findOriginalAutoLang", () => {
	test("regional language matches the base -orig key", () => {
		expect(findOriginalAutoLang(["en", "en-orig", "fr-orig"], "en-US")).toBe(
			"en-orig",
		);
	});
	test("several -orig keys and no language is ambiguous", () => {
		expect(findOriginalAutoLang(["en-orig", "fr-orig"], null)).toBeUndefined();
	});
});

describe("subtitleLangAliases", () => {
	test("regional -orig also asks for the base -orig", () => {
		expect(subtitleLangAliases("en-US-orig")).toEqual([
			"en-US-orig",
			"en-orig",
		]);
	});
	test("base -orig also asks for regional spellings", () => {
		const aliases = subtitleLangAliases("en-orig");
		expect(aliases[0]).toBe("en-orig");
		const re = new RegExp(`^(?:${aliases[1]})$`);
		expect(re.test("en-US-orig")).toBe(true);
		expect(re.test("en-orig")).toBe(false);
		expect(re.test("fr-orig")).toBe(false);
		expect(re.test("en-US")).toBe(false);
	});
	test("plain keys are asked for exactly", () => {
		expect(subtitleLangAliases("pt-BR")).toEqual(["pt-BR"]);
		expect(subtitleLangAliases("zh-Hans")).toEqual(["zh-Hans"]);
	});
});

describe("pickSubtitleFile", () => {
	const id = "ab-cd_EF123";

	test("parses the language from yt-dlp's file name", () => {
		expect(subtitleFileLang(`${id}.en-US-orig.vtt`, id)).toBe("en-US-orig");
		expect(subtitleFileLang(`${id}.en.vtt`, id)).toBe("en");
		expect(subtitleFileLang("other.en.vtt", id)).toBeNull();
		expect(subtitleFileLang(`${id}.en.srt`, id)).toBeNull();
	});

	test("listing said en-US-orig, download only wrote en-orig", () => {
		expect(
			pickSubtitleFile(
				[`${id}.en-orig.vtt`],
				id,
				subtitleLangAliases("en-US-orig"),
			),
		).toEqual({ file: `${id}.en-orig.vtt`, lang: "en-orig" });
	});

	test("listing said en-orig, download only wrote en-US-orig", () => {
		expect(
			pickSubtitleFile(
				[`${id}.en-US-orig.vtt`],
				id,
				subtitleLangAliases("en-orig"),
			),
		).toEqual({ file: `${id}.en-US-orig.vtt`, lang: "en-US-orig" });
	});

	test("prefers the exact key when both were written", () => {
		expect(
			pickSubtitleFile(
				[`${id}.en-orig.vtt`, `${id}.en-US-orig.vtt`],
				id,
				subtitleLangAliases("en-US-orig"),
			)?.lang,
		).toBe("en-US-orig");
	});

	test("exact key only: en does not pick up en-orig or en-GB", () => {
		expect(
			pickSubtitleFile(
				[`${id}.en-orig.vtt`, `${id}.en-GB.vtt`],
				id,
				subtitleLangAliases("en"),
			),
		).toBeNull();
	});

	test("nothing written", () => {
		expect(pickSubtitleFile([], id, ["en"])).toBeNull();
	});
});
