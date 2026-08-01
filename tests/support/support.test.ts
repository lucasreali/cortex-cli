import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomically } from "@/support/atomic-write";
import { userCortexDir } from "@/support/cortex-home";
import { errnoCode, errorMessage } from "@/support/errors";
import { sha256Hex } from "@/support/hash";
import { parseJsonOrNull } from "@/support/json";
import { truncate } from "@/support/text";

describe("errorMessage", () => {
	test("unwraps an Error and stringifies anything else", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});

describe("errnoCode", () => {
	test("reads the code off a syscall error and nothing off the rest", () => {
		const failure = Object.assign(new Error("nope"), { code: "EEXIST" });
		expect(errnoCode(failure)).toBe("EEXIST");
		expect(errnoCode(new Error("no code"))).toBeUndefined();
		expect(errnoCode(undefined)).toBeUndefined();
	});
});

describe("parseJsonOrNull", () => {
	test("parses valid JSON and answers null for the rest", () => {
		expect(parseJsonOrNull<{ id: number }>('{"id":7}')).toEqual({ id: 7 });
		expect(parseJsonOrNull("not json")).toBeNull();
		expect(parseJsonOrNull("")).toBeNull();
	});
});

describe("truncate", () => {
	test("leaves short text alone and ellipsises the rest to max", () => {
		expect(truncate("short", 10)).toBe("short");
		expect(truncate("exactly-10", 10)).toBe("exactly-10");
		expect(truncate("abcdefghijk", 5)).toBe("abcd…");
		expect(truncate("abcdefghijk", 5)).toHaveLength(5);
	});
});

describe("sha256Hex", () => {
	test("hashes bytes and strings to the same digest", () => {
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update("cortex");
		const expected = hasher.digest("hex");
		expect(sha256Hex("cortex")).toBe(expected);
		expect(sha256Hex(new TextEncoder().encode("cortex"))).toBe(expected);
	});
});

describe("userCortexDir", () => {
	test("an override wins over the per-user default", () => {
		expect(userCortexDir("models", "/somewhere/else")).toBe("/somewhere/else");
		expect(userCortexDir("models", undefined)).toEndWith("/.cortex/models");
	});
});

describe("writeAtomically", () => {
	test("publishes the file under its final name with nothing left staged", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cortex-atomic-"));
		const target = join(directory, "asset.bin");
		await writeAtomically(target, "payload");
		expect(readFileSync(target, "utf8")).toBe("payload");
		expect(readdirSync(directory)).toEqual(["asset.bin"]);
	});

	test("replaces an existing file in place", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cortex-atomic-"));
		const target = join(directory, "asset.bin");
		await writeAtomically(target, "first");
		await writeAtomically(target, "second");
		expect(readFileSync(target, "utf8")).toBe("second");
		expect(readdirSync(directory)).toEqual(["asset.bin"]);
	});
});
