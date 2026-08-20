import { describe, expect, test } from "bun:test";
import {
	canonicalSymbolName,
	QUALIFIED_SEPARATOR,
	symbolKey,
	symbolKeyParts,
} from "@/support/symbol-key";

const IDENTIFIER_ONLY = /^[\p{L}\p{N}_$.]*$/u;

// Every shape the three producers can disagree on: the Turkish dotted capital
// whose lowercase expands, the dotless lowercase it is not equal to, ligatures
// only compatibility decomposition folds, both spellings of an accented letter,
// fullwidth forms, characters an identifier cannot contain, and the qualified
// separator matching depends on.
const CORPUS = [
	"",
	"İ",
	"ı",
	"I",
	"i",
	"İstanbulService.İşlem",
	"ﬁle",
	"ﬀ",
	"ﬁlterTokens",
	"café",
	"café",
	"éclair",
	"Ａｕｔｈ",
	"ǅungla",
	"ẞ",
	"AuthService.validateToken",
	"AuthService.validateToken.inner",
	"..AuthService..validateToken..",
	"AuthService<T>.validateToken(token)",
	"$scope",
	"_private",
	"handlér",
	"σΣς",
	"日本語クラス.メソッド",
	" spaced name ",
	"emoji🙂Name",
];

describe("symbolKey", () => {
	test("is idempotent over the corpus", () => {
		for (const name of CORPUS) {
			const key = symbolKey(name);
			expect(symbolKey(key)).toBe(key);
		}
	});

	test("is idempotent over every code point in the BMP", () => {
		const offenders: string[] = [];
		for (let point = 1; point <= 0xffff; point++) {
			if (point >= 0xd800 && point <= 0xdfff) continue;
			const key = symbolKey(String.fromCodePoint(point));
			if (symbolKey(key) !== key) offenders.push(point.toString(16));
		}
		expect(offenders).toEqual([]);
	});

	test("emits only identifier characters and the separator", () => {
		for (const name of CORPUS) {
			expect(symbolKey(name)).toMatch(IDENTIFIER_ONLY);
		}
	});

	// The regression that motivates the step order. Filtering the non-identifier
	// characters before the case mapping leaves the combining dot that
	// lowercasing U+0130 produces, and a second pass then removes it — the
	// extractor and the matcher would disagree on every Turkish identifier.
	test("folds the Turkish dotted capital to a fixed point", () => {
		expect("İ".toLowerCase()).toBe("i̇");
		const filterThenFold = (name: string) =>
			name.replace(/[^\p{L}\p{N}_$.]/gu, "").toLowerCase();
		expect(filterThenFold(filterThenFold("İ"))).not.toBe(filterThenFold("İ"));

		expect(symbolKey("İ")).toBe("i");
		expect(symbolKey("i̇")).toBe("i");
		expect(symbolKey("İstanbulService.İşlem")).toBe("istanbulservice.islem");
	});

	test("keeps the dotless i distinct from the dotted one it is not", () => {
		expect(symbolKey("ı")).toBe("ı");
		expect(symbolKey("ı")).not.toBe(symbolKey("i"));
	});

	test("folds ligatures, fullwidth forms and both spellings of an accent", () => {
		expect(symbolKey("ﬁle")).toBe("file");
		expect(symbolKey("Ａｕｔｈ")).toBe("auth");
		expect(symbolKey("café")).toBe(symbolKey("café"));
		expect(symbolKey("café")).toBe("cafe");
	});

	test("preserves the qualified-name separator and collapses the rest", () => {
		expect(symbolKey("AuthService.validateToken")).toBe(
			"authservice.validatetoken",
		);
		expect(symbolKey("..AuthService..validateToken..")).toBe(
			"authservice.validatetoken",
		);
		expect(symbolKey(" AuthService . validateToken ")).toBe(
			"authservice.validatetoken",
		);
		// Only the dot separates: anything else is dropped, never translated.
		expect(symbolKey("AuthService#validateToken")).toBe(
			"authservicevalidatetoken",
		);
		expect(symbolKey("$scope")).toBe("$scope");
		expect(symbolKey("emoji🙂Name")).toBe("emojiname");
		expect(QUALIFIED_SEPARATOR).toBe(".");
	});
});

describe("canonicalSymbolName", () => {
	test("is idempotent and emits only identifier characters", () => {
		for (const name of CORPUS) {
			const canonical = canonicalSymbolName(name);
			expect(canonicalSymbolName(canonical)).toBe(canonical);
			expect(canonical).toMatch(IDENTIFIER_ONLY);
		}
	});

	test("keeps the case a human wrote, because it is shown back", () => {
		expect(canonicalSymbolName("AuthService.validateToken")).toBe(
			"AuthService.validateToken",
		);
		expect(canonicalSymbolName("ﬁlterTokens")).toBe("filterTokens");
		expect(canonicalSymbolName("İ")).toBe("I");
	});

	// What makes the two stages one recipe: canonicalizing on the way into the
	// index can never change the answer the matching side computes.
	test("does not change the key of anything it canonicalizes", () => {
		for (const name of CORPUS) {
			expect(symbolKey(canonicalSymbolName(name))).toBe(symbolKey(name));
		}
	});
});

describe("symbolKeyParts", () => {
	test("splits a qualified key into its owner and last segment", () => {
		expect(symbolKeyParts("AuthService.validateToken")).toEqual({
			key: "authservice.validatetoken",
			owner: "authservice",
			lastSegment: "validatetoken",
		});
	});

	test("leaves an unqualified key without an owner", () => {
		expect(symbolKeyParts("login")).toEqual({
			key: "login",
			owner: "",
			lastSegment: "login",
		});
	});

	test("treats every segment but the last as the owner", () => {
		expect(symbolKeyParts("Outer.Inner.method")).toEqual({
			key: "outer.inner.method",
			owner: "outer.inner",
			lastSegment: "method",
		});
	});

	test("answers an empty key for a name with nothing to keep", () => {
		expect(symbolKeyParts("<>()")).toEqual({
			key: "",
			owner: "",
			lastSegment: "",
		});
	});
});
