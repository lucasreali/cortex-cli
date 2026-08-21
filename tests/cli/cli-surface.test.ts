import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE } from "@/cli/usage";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const DECISION_ID = "019f0000-0000-7000-8000-00000000c001";

let dir: string;
let emptyDir: string;
let fakeHome: string;

beforeAll(() => {
	fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-surface-home-")));
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-surface-")));
	emptyDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-surface-bare-")));
	expect(cli("init", "--yes").code).toBe(0);
	writeDecision();
	expect(cli("sync").code).toBe(0);
});

afterAll(() => {
	for (const path of [dir, emptyDir, fakeHome]) {
		rmSync(path, { recursive: true, force: true });
	}
});

function run(cwd: string, args: string[]) {
	const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", HOME: fakeHome },
	});
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function cli(...args: string[]) {
	return run(dir, args);
}

function writeDecision(): void {
	mkdirSync(join(dir, ".cortex", "decisions"), { recursive: true });
	writeFileSync(
		join(dir, ".cortex", "decisions", `${DECISION_ID}.md`),
		[
			"---",
			'title: "Anchor the parser on the file, not the branch"',
			'keywords: ["parser", "anchor", "branch", "file", "decision"]',
			'provenance: "agent"',
			'created_at: "2026-08-14T12:00:00.000Z"',
			"---",
			"",
			"The parser reads the working tree.",
			"",
		].join("\n"),
	);
}

// Every error the CLI prints goes through one reporter, so the flag that makes
// stdout parseable makes stderr parseable too. A caller that has to scrape
// "✗ decision not found: x" out of a decorated sentence is a caller that will
// get it wrong.
describe("--json on the error paths", () => {
	function errorFrom(result: { stderr: string }): unknown {
		return JSON.parse(result.stderr).error;
	}

	test("a usage error is an object, not a usage line", () => {
		const result = cli("impact", "--json");
		expect(result.code).toBe(1);
		expect(errorFrom(result)).toBe(`usage: cortex ${USAGE.impact}`);
	});

	test("a decision that does not exist is an object", () => {
		const result = cli("impact", "no-such-decision", "--json");
		expect(result.code).toBe(1);
		expect(errorFrom(result)).toBe("decision not found: no-such-decision");
	});

	test("an uninitialized project is an object", () => {
		const result = run(emptyDir, ["log", "--json"]);
		expect(result.code).toBe(1);
		expect(errorFrom(result)).toBe(
			"Cortex is not initialized here — run: cortex init",
		);
	});

	test("a commit no decision was recorded at is an object", () => {
		const result = cli("log", "--since", "deadbee", "--json");
		expect(result.code).toBe(1);
		expect(errorFrom(result)).toContain("No decision was recorded at commit");
	});

	test("the same failures stay human without the flag", () => {
		expect(cli("impact").stderr).toStartWith("✗ ");
		expect(cli("impact", "no-such-decision").stderr).toStartWith("✗ ");
		expect(run(emptyDir, ["log"]).stderr).toStartWith("✗ ");
	});

	// `cortex init --json` is a typo, not a request for machine-readable output:
	// answering it in JSON would promise a shape init never prints.
	test("a command that cannot print JSON does not learn to on failure", () => {
		const result = run(emptyDir, ["index", "--json"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toStartWith("✗ ");
	});
});

describe("a decisions.db that is not a database", () => {
	let corruptDir: string;

	beforeAll(() => {
		corruptDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-corrupt-")));
		mkdirSync(join(corruptDir, ".cortex", "decisions"), { recursive: true });
		writeFileSync(
			join(corruptDir, ".cortex", "decisions.db"),
			"not a database",
		);
	});

	afterAll(() => {
		rmSync(corruptDir, { recursive: true, force: true });
	});

	// It is a derived cache and the decision files are the product, so the one
	// thing this must not say is the bare SQLite sentence it used to die on.
	test("doctor names the file and the way back", () => {
		const result = run(corruptDir, ["doctor"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			join(corruptDir, ".cortex", "decisions.db"),
		);
		expect(result.stderr).toContain("rebuildable cache");
		expect(result.stderr).toContain("cortex sync");
	});

	test("every other read command says the same thing", () => {
		for (const args of [["log"], ["why", "x"], ["search", "x"]]) {
			const result = run(corruptDir, args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("rebuildable cache");
		}
	});

	test("--json says it as an object", () => {
		const result = run(corruptDir, ["doctor", "--json"]);
		expect(JSON.parse(result.stderr).error).toContain("rebuildable cache");
	});
});

describe("flags stop at the terminator", () => {
	test("`search -- -h` searches for -h instead of printing help", () => {
		const result = cli("search", "--", "-h");
		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("search decisions by meaning");
	});

	test("`search -- --json` searches for --json instead of printing JSON", () => {
		const result = cli("search", "--", "--json");
		expect(result.code).toBe(0);
		expect(result.stdout).not.toStartWith("[");
	});

	test("-h before the terminator still prints help", () => {
		expect(cli("search", "-h").stdout).toContain(
			"search decisions by meaning or keyword",
		);
	});
});

describe("blank and malformed arguments", () => {
	test("an argument that quoting emptied is a missing argument", () => {
		for (const command of ["why", "impact", "search"]) {
			const result = cli(command, "   ");
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`usage: cortex ${command}`);
		}
	});

	test("--depth takes digits, not everything Number would read", () => {
		for (const depth of ["1e3", "0x10", "2.5", "-1"]) {
			const result = cli("impact", DECISION_ID, `--depth=${depth}`);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("non-negative integer");
		}
	});

	test("--depth 0 is a depth, not a missing one", () => {
		expect(cli("impact", DECISION_ID, "--depth", "0").code).toBe(0);
	});
});

describe("usage lines come from one place", () => {
	test("serve prints the shared line rather than its own copy", () => {
		const result = cli("serve");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`usage: cortex ${USAGE.serve}`);
	});

	test("serve refuses a flag it does not know", () => {
		const result = cli("serve", "--mcp", "--bogus");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--bogus");
	});

	test("upgrade's own usage line is the one --help prints", () => {
		const result = cli("upgrade", "--json");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`usage: cortex ${USAGE.upgrade}`);
	});
});

// The other two hidden commands already explain themselves to a person who
// found them in a process list; these two answered with silence or a bound
// socket. A terminal on stdin is the whole signal — they are only ever spawned
// with pipes.
describe.skipIf(!Bun.which("script"))("the hidden embedding commands", () => {
	function onPty(...command: string[]): string {
		const argv =
			process.platform === "darwin"
				? ["script", "-q", "/dev/null", ...command]
				: ["script", "-qec", command.join(" "), "/dev/null"];
		return Bun.spawnSync(argv, {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: fakeHome, NO_COLOR: "1" },
		})
			.stdout.toString()
			.replace(/\r/g, "");
	}

	test("embed-worker points a person at the command they meant", () => {
		const output = onPty("bun", MAIN_PATH, "embed-worker");
		expect(output).toContain("private embedding subprocess");
		expect(output).toContain("cortex embed --missing");
	});

	test("embed-daemon points a person at doctor, and binds nothing", () => {
		const output = onPty("bun", MAIN_PATH, "embed-daemon");
		expect(output).toContain("per-user embedding daemon");
		expect(output).toContain("cortex doctor");
	});
});

// --git-hooks is exclusive, so --target cannot be honoured alongside it. It was
// being parsed, discarded and its validation skipped — a bad value exited 0.
describe("install --git-hooks", () => {
	test("refuses --target instead of discarding it", () => {
		const result = run(emptyDir, [
			"install",
			"--git-hooks",
			"--target",
			"bogus",
			"--yes",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--target");
		expect(existsSync(join(emptyDir, ".git", "hooks", "post-commit"))).toBe(
			false,
		);
	});
});
