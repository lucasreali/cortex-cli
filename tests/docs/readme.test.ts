import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GROUND_TRUTH } from "@tests/evaluation/ground-truth";
import { USAGE } from "@/cli/usage";
import { resolveServerSpec } from "@/install/server-spec";

const ROOT = new URL("../../", import.meta.url).pathname;
const MAIN_PATH = join(ROOT, "src", "cli", "main.ts");

const readme = await Bun.file(join(ROOT, "README.md")).text();
const benchmarks = await Bun.file(join(ROOT, "BENCHMARKS.md")).text();

function section(markdown: string, heading: string): string {
	const start = markdown.indexOf(`\n## ${heading}\n`);
	if (start === -1) throw new Error(`README has no "## ${heading}" section`);
	const end = markdown.indexOf("\n## ", start + 1);
	return markdown.slice(start, end === -1 ? undefined : end);
}

function fencedBlocks(markdown: string, language: string): string[] {
	const fences = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, "g");
	return [...markdown.matchAll(fences)].map((match) => match[1] ?? "");
}

function onlyBlock(markdown: string, language: string): string {
	const blocks = fencedBlocks(markdown, language);
	expect(blocks, `expected exactly one ${language} block`).toHaveLength(1);
	return blocks[0] ?? "";
}

// A flag or a positional placeholder: the parts of a usage line a reader has to
// be told about, as opposed to the metavariables (`T`, `SHA`) that only make
// sense next to them.
const DOCUMENTABLE = /--[a-z][a-z-]*|<[^>]+>/g;

function documentableTokens(usage: string): string[] {
	return [...new Set(usage.match(DOCUMENTABLE) ?? [])];
}

// `cortex --help` is the authority on which commands are public: the hidden
// ones (prompt-hook, git-hook, embed-worker, embed-daemon) are spawned by
// cortex itself and are not part of the surface the README documents.
function advertisedCommands(): string[] {
	const help = Bun.spawnSync(["bun", MAIN_PATH, "--help"], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	expect(help.exitCode, help.stderr.toString()).toBe(0);
	const body = help.stdout.toString();
	const commands = body.slice(
		body.indexOf("commands:"),
		body.indexOf("flags:"),
	);
	return commands
		.split("\n")
		.map((line) => line.match(/^ {2}(\S+)/)?.[1])
		.filter((name): name is string => name !== undefined);
}

const cliBlock = onlyBlock(section(readme, "CLI"), "bash");

function documentedLines(command: string): string[] {
	return cliBlock
		.split("\n")
		.filter((line) => line.startsWith(`cortex ${command} `))
		.concat(
			cliBlock.split("\n").filter((line) => line === `cortex ${command}`),
		);
}

const advertised = advertisedCommands();

describe("the README's CLI block is the CLI's surface", () => {
	test("every command cortex --help advertises is documented", () => {
		for (const command of advertised) {
			expect(
				documentedLines(command),
				`README omits cortex ${command}`,
			).not.toHaveLength(0);
		}
	});

	test("it documents no command the CLI does not advertise", () => {
		const documented = cliBlock
			.split("\n")
			.map((line) => line.match(/^cortex (\S+)/)?.[1])
			.filter((name): name is string => name !== undefined);
		for (const command of documented) {
			expect(advertised, `README documents cortex ${command}`).toContain(
				command,
			);
		}
	});

	test("every flag and argument of a command reaches the README", () => {
		for (const command of advertised) {
			const usage = USAGE[command as keyof typeof USAGE];
			const lines = documentedLines(command).join("\n");
			for (const token of documentableTokens(usage)) {
				expect(lines, `README omits ${token} from cortex ${command}`).toContain(
					token,
				);
			}
		}
	});

	test("the extractor still finds the block it grades", () => {
		expect(advertised.length).toBeGreaterThan(5);
		expect(cliBlock).toContain("cortex ");
	});
});

// BENCHMARKS.md is written by `cortex benchmark --write` and by nothing else,
// so the README's copy is the half that can go stale — and it did, by every
// cell, while the file it links to two paragraphs later was current.
describe("the README quotes the numbers their own commands print", () => {
	function benchmarkTable(markdown: string): string {
		const table = markdown.match(
			/\| what the agent reads per question \|[\s\S]*?\n\n/,
		);
		if (!table) throw new Error("no benchmark table found");
		return table[0].trim();
	}

	function activeDecisions(markdown: string, preposition: string): string {
		const count = markdown.match(
			new RegExp(`${preposition} (\\d+) active decisions`),
		);
		if (!count) throw new Error(`no "${preposition} N active decisions" found`);
		return count[1] ?? "";
	}

	test("the benchmark table matches BENCHMARKS.md cell for cell", () => {
		expect(benchmarkTable(readme)).toBe(benchmarkTable(benchmarks));
	});

	test("both name the same corpus size", () => {
		expect(activeDecisions(readme, "at")).toBe(
			activeDecisions(benchmarks, "in"),
		);
	});

	test("the recall claim counts the cases the eval actually runs", () => {
		const claim = readme.match(/over (\d+) evaluation cases/);
		expect(claim, "README states no evaluation case count").not.toBeNull();
		expect(Number(claim?.[1])).toBe(GROUND_TRUTH.length);
	});
});

// MCP clients spawn the server with no shell between them and execve, so a
// snippet that leans on one is a snippet that fails with ENOENT — and the files
// it is pasted into are strict JSON, where a comment costs the user the config
// their whole agent setup lives in.
describe("the manual MCP registration snippet is pasteable", () => {
	const setup = section(readme, "Setup");
	const json = onlyBlock(setup, "json");
	const toml = onlyBlock(setup, "toml");
	const spec = resolveServerSpec({
		compiled: true,
		binaryPath: "/home/you/.local/bin/cortex",
		onPath: null,
	}).spec;

	interface Registration {
		mcpServers: Record<string, { command: string; args: string[] }>;
	}

	function registeredServer(): { command: string; args: string[] } {
		const parsed = JSON.parse(json) as Registration;
		const server = parsed.mcpServers.cortex;
		if (!server) throw new Error("the snippet registers no cortex server");
		return server;
	}

	test("it parses as strict JSON", () => {
		expect(() => JSON.parse(json)).not.toThrow();
	});

	test("it spawns the binary the installer would register", () => {
		expect(registeredServer().args).toEqual(spec.args);
		expect(registeredServer().command).toBe(spec.command);
	});

	test("no path in it needs a shell to resolve", () => {
		for (const block of [json, toml]) {
			for (const path of block.match(/"[^"]*cortex[^"]*"/g) ?? []) {
				expect(
					path,
					"a shell-expanded path reaches execve verbatim",
				).not.toMatch(/\$HOME|~|\$\{/);
			}
		}
	});
});
