import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppendOnlyLog } from "@/support/append-only-log";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-append-log-"));
	path = join(dir, "nested", "log.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function log(): AppendOnlyLog {
	return new AppendOnlyLog(path);
}

function keepingLast(count: number): (text: string) => string {
	return (text) =>
		text
			.split("\n")
			.filter(Boolean)
			.slice(-count)
			.map((line) => `${line}\n`)
			.join("");
}

describe("AppendOnlyLog", () => {
	test("a log that is not there yet reads as empty and weighs nothing", () => {
		expect(log().read()).toBe("");
		expect(log().sizeInBytes()).toBe(0);
	});

	test("appending creates the directory and reports that it landed", () => {
		expect(log().append("a\n")).toBe(true);
		expect(log().read()).toBe("a\n");
	});

	test("an unwritable path is reported, not thrown", () => {
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "not a directory");
		const blockedLog = new AppendOnlyLog(join(blocked, "log.jsonl"));

		expect(blockedLog.append("a\n")).toBe(false);
	});

	test("size is in bytes, not characters", () => {
		log().append("é\n");

		expect(log().sizeInBytes()).toBe(3);
	});
});

describe("AppendOnlyLog — compaction", () => {
	test("a pass that shortens nothing leaves the file untouched", () => {
		const one = log();
		one.append("a\nb\n");

		one.compact((text) => text);

		expect(readFileSync(path, "utf8")).toBe("a\nb\n");
	});

	test("what the pass drops is gone", () => {
		const one = log();
		one.append("a\nb\nc\n");

		one.compact(keepingLast(1));

		expect(readFileSync(path, "utf8")).toBe("c\n");
	});

	// The whole point of re-reading before the rename: the pass runs on a
	// snapshot, and another process appending to the real file meanwhile must
	// not have its line replaced by the shortened snapshot.
	test("a line another process appended while the pass ran is put back", () => {
		const one = log();
		one.append("a\nb\nc\n");

		one.compact((text) => {
			appendFileSync(path, "elsewhere\n");
			return keepingLast(1)(text);
		});

		expect(readFileSync(path, "utf8")).toBe("c\nelsewhere\n");
	});

	test("the late tail is cut on bytes, so multi-byte lines survive intact", () => {
		const one = log();
		one.append("é\nü\n");

		one.compact((text) => {
			appendFileSync(path, "ç\n");
			return keepingLast(1)(text);
		});

		expect(readFileSync(path, "utf8")).toBe("ü\nç\n");
	});

	test("a log that cannot be rewritten keeps what it had", () => {
		const one = log();
		one.append("a\nb\n");
		rmSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "nested"), "not a directory");

		expect(() => one.compact(keepingLast(1))).not.toThrow();
	});
});
