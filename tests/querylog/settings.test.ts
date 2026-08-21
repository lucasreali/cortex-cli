import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	DISABLE_VARIABLE,
	defaultQueryLogPath,
	ENABLE_VARIABLE,
	PATH_VARIABLE,
	QueryLogSettings,
} from "@/querylog/settings";

const CORTEX_DIR = "/repo/.cortex";

function settings(environment: Record<string, string | undefined>) {
	return QueryLogSettings.from(CORTEX_DIR, environment);
}

describe("QueryLogSettings", () => {
	test("recording is off when nothing is set", () => {
		expect(settings({}).enabled).toBe(false);
	});

	test(`${ENABLE_VARIABLE}=1 turns recording on`, () => {
		expect(settings({ [ENABLE_VARIABLE]: "1" }).enabled).toBe(true);
	});

	test("any other value of the enable flag leaves it off", () => {
		expect(settings({ [ENABLE_VARIABLE]: "true" }).enabled).toBe(false);
		expect(settings({ [ENABLE_VARIABLE]: "0" }).enabled).toBe(false);
	});

	test(`${DISABLE_VARIABLE}=1 wins over the enable flag`, () => {
		const both = settings({
			[ENABLE_VARIABLE]: "1",
			[DISABLE_VARIABLE]: "1",
		});

		expect(both.enabled).toBe(false);
	});

	test("the default path sits beside the other local sidecars", () => {
		expect(settings({}).path).toBe(join(CORTEX_DIR, "local", "queries.jsonl"));
		expect(defaultQueryLogPath(CORTEX_DIR)).toBe(settings({}).path);
	});

	test(`${PATH_VARIABLE} relocates the log`, () => {
		expect(settings({ [PATH_VARIABLE]: "/elsewhere/q.jsonl" }).path).toBe(
			"/elsewhere/q.jsonl",
		);
	});

	test("an explicit path says where, never whether", () => {
		expect(settings({ [PATH_VARIABLE]: "/elsewhere/q.jsonl" }).enabled).toBe(
			false,
		);
	});

	test("an empty path variable falls back to the default", () => {
		expect(settings({ [PATH_VARIABLE]: "" }).path).toBe(
			defaultQueryLogPath(CORTEX_DIR),
		);
	});

	test("the process environment is the default source", () => {
		process.env[ENABLE_VARIABLE] = "1";
		try {
			expect(QueryLogSettings.from(CORTEX_DIR).enabled).toBe(true);
		} finally {
			delete process.env[ENABLE_VARIABLE];
		}
	});
});
