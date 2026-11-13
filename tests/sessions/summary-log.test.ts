import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionSummaryLog } from "@/sessions/summary-log";

const OLDER = "019f0000-0000-7000-8000-000000000001";
const NEWER = "019f0000-0000-7000-8000-000000000002";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-sessions-"));
	path = join(dir, "local", "sessions.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("SessionSummaryLog", () => {
	test("the latest narrative of a session wins, newest session first", () => {
		const log = new SessionSummaryLog(path);
		log.record(OLDER, "Primeira versão.", new Date("2026-11-01T00:00:00Z"));
		log.record(NEWER, "Outra sessão.", new Date("2026-11-02T00:00:00Z"));
		log.record(OLDER, "Versão final.", new Date("2026-11-03T00:00:00Z"));

		expect(log.list(10)).toEqual([
			{
				id: NEWER,
				summary: "Outra sessão.",
				createdAt: "2026-11-02T00:00:00.000Z",
			},
			{
				id: OLDER,
				summary: "Versão final.",
				createdAt: "2026-11-03T00:00:00.000Z",
			},
		]);
		expect(log.list(1).map((entry) => entry.id)).toEqual([NEWER]);
	});

	test("merges what decisions.db still holds, the log winning", () => {
		const log = new SessionSummaryLog(path);
		log.record(NEWER, "Do log.");

		expect(
			log
				.list(10, [
					{ id: NEWER, summary: "Do banco.", createdAt: "x" },
					{ id: OLDER, summary: "Só no banco.", createdAt: "y" },
				])
				.map((entry) => entry.summary),
		).toEqual(["Do log.", "Só no banco."]);
	});

	test("skips lines it cannot read", () => {
		const log = new SessionSummaryLog(path);
		log.record(OLDER, "Válida.");
		writeFileSync(path, '{"session":1}\nnot json\n', { flag: "a" });

		expect(log.list(10).map((entry) => entry.summary)).toEqual(["Válida."]);
	});

	test("compacts to the latest summary per session once it grows", () => {
		const log = new SessionSummaryLog(path);
		const long = "x".repeat(64 * 1024);
		for (let index = 0; index < 20; index += 1) log.record(OLDER, long);
		log.record(NEWER, "Curta.");

		expect(statSync(path).size).toBeLessThan(1024 * 1024);
		expect(log.list(10).map((entry) => entry.id)).toEqual([NEWER, OLDER]);
	});
});
