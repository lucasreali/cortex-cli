import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEntries } from "@/querylog/entry";
import {
	DISABLE_VARIABLE,
	ENABLE_VARIABLE,
	PATH_VARIABLE,
} from "@/querylog/settings";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;

let dir: string;
let fakeHome: string;

function cli(
	environment: Record<string, string>,
	...args: string[]
): { code: number; stdout: string } {
	const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			CORTEX_DISABLE_EMBEDDINGS: "1",
			HOME: fakeHome,
			[ENABLE_VARIABLE]: "",
			[DISABLE_VARIABLE]: "",
			[PATH_VARIABLE]: "",
			...environment,
		},
	});
	return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
}

function git(...args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd: dir, stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function logPath(): string {
	return join(dir, ".cortex", "local", "queries.jsonl");
}

function recorded() {
	return decodeEntries(readFileSync(logPath(), "utf8"));
}

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-querylog-cli-")));
	fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-querylog-home-")));
	git("init", "-b", "main");
	git("remote", "add", "origin", "git@github.com:acme/demo.git");
	cli({}, "init", "--yes");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("the query log is off until it is turned on", () => {
	test("a search records nothing by default", () => {
		cli({}, "search", "autenticacao");

		expect(existsSync(logPath())).toBe(false);
	});

	test("doctor reports the off state as a fact, not an issue", () => {
		const result = cli({}, "doctor", "--json");
		const checks = JSON.parse(result.stdout).checks as Array<{
			level: string;
			message: string;
		}>;
		const line = checks.find((check) => check.message.startsWith("query log:"));

		expect(line?.level).toBe("ok");
		expect(line?.message).toContain("off");
		expect(line?.message).toContain(ENABLE_VARIABLE);
	});

	test(`${DISABLE_VARIABLE}=1 wins over ${ENABLE_VARIABLE}=1`, () => {
		cli(
			{ [ENABLE_VARIABLE]: "1", [DISABLE_VARIABLE]: "1" },
			"search",
			"autenticacao",
		);

		expect(existsSync(logPath())).toBe(false);
	});
});

describe("an opted-in query log", () => {
	test("a search is recorded with its terms and result count", () => {
		cli({ [ENABLE_VARIABLE]: "1" }, "search", "autenticacao", "jwt");

		expect(recorded().at(-1)).toMatchObject({
			surface: "search",
			query: "autenticacao jwt",
			terms: ["autenticacao", "jwt"],
			exact: false,
			results: 0,
			ids: [],
		});
	});

	test("doctor counts the queries that returned nothing", () => {
		const result = cli({ [ENABLE_VARIABLE]: "1" }, "doctor");

		expect(result.stdout).toContain("returned nothing");
	});

	test("doctor says so when recording is on and nothing is there yet", () => {
		const result = cli(
			{
				[ENABLE_VARIABLE]: "1",
				[PATH_VARIABLE]: join(fakeHome, "unwritten.jsonl"),
			},
			"doctor",
		);

		expect(result.stdout).toContain("query log: on, nothing recorded yet");
	});

	test("a log left behind is named while recording is off", () => {
		const result = cli({}, "doctor");

		expect(result.stdout).toContain("query log: off");
		expect(result.stdout).toContain("queries.jsonl");
	});

	test(`${PATH_VARIABLE} moves the log out of the project`, () => {
		const elsewhere = join(fakeHome, "queries.jsonl");

		cli(
			{ [ENABLE_VARIABLE]: "1", [PATH_VARIABLE]: elsewhere },
			"search",
			"outra",
		);

		expect(decodeEntries(readFileSync(elsewhere, "utf8"))).toHaveLength(1);
	});
});
