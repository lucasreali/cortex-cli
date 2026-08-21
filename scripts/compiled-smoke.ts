// End-to-end proof that the compiled binary works without the Bun runtime or
// node_modules.
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CORTEX_VERSION } from "@/version";
import { DEFAULT_OUTFILE, ROOT } from "./compile";

// The release job unpacks the tarball it is about to publish and points this
// at the binary inside it, so the bytes that are smoke-tested are the bytes
// that ship rather than a second compile of the same source.
const PUBLISHED_BINARY = process.env.CORTEX_SMOKE_BINARY;
const BINARY = PUBLISHED_BINARY ?? DEFAULT_OUTFILE;

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

let projectDir = "";

function cortex(...argv: string[]): CommandResult {
	return runCortex(argv, {});
}

function runCortex(
	argv: string[],
	extraEnvironment: Record<string, string>,
): CommandResult {
	const environment = { ...process.env, ...extraEnvironment };
	delete environment.CORTEX_DISABLE_EMBEDDINGS;
	const result = Bun.spawnSync([BINARY, ...argv], {
		cwd: projectDir,
		stdout: "pipe",
		stderr: "pipe",
		env: environment,
	});
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function step(name: string, result: CommandResult, expected: string): void {
	if (result.code !== 0 || !result.stdout.includes(expected)) {
		console.error(`✗ ${name}`);
		console.error(`  exit ${result.code}`);
		console.error(`  stdout: ${result.stdout.trim()}`);
		console.error(`  stderr: ${result.stderr.trim()}`);
		process.exit(1);
	}
	console.log(`✓ ${name}`);
}

// releaseOrigin decides whether it is running from an installed binary by
// looking for Bun's embedded filesystem in its own module URL — a property only
// the compiled binary has, and therefore the one thing the test suite, which
// always runs from source, cannot prove.
function refuses(name: string, result: CommandResult, expected: string): void {
	if (result.code === 0 || !result.stderr.includes(expected)) {
		console.error(`✗ ${name}`);
		console.error(`  exit ${result.code}`);
		console.error(`  stdout: ${result.stdout.trim()}`);
		console.error(`  stderr: ${result.stderr.trim()}`);
		process.exit(1);
	}
	console.log(`✓ ${name}`);
}

function git(...argv: string[]): void {
	const result = Bun.spawnSync(["git", ...argv], {
		cwd: projectDir,
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

// Outside the project: a file inside it would be one the code index has not
// seen, and doctor would rightly call the index outdated.
function refusingWorker(): string {
	const path = join(
		mkdtempSync(join(tmpdir(), "cortex-smoke-worker-")),
		"w.ts",
	);
	writeFileSync(path, "process.exit(1);\n");
	return path;
}

function makeProject(): void {
	projectDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-smoke-")));
	git("init", "-b", "main");
	git("remote", "add", "origin", "git@github.com:acme/compiled-smoke.git");
	mkdirSync(join(projectDir, "src"));
	writeFileSync(
		join(projectDir, "src", "service.ts"),
		"export class AuthService {\n\tvalidateToken(token: string): boolean {\n\t\treturn token.length > 0;\n\t}\n}\n",
	);
	git("add", ".");
	git(
		"-c",
		"user.email=smoke@example.com",
		"-c",
		"user.name=Smoke",
		"commit",
		"-m",
		"init",
		"--no-gpg-sign",
	);
}

async function saveDecisionOverMcp(): Promise<void> {
	const client = new Client({ name: "compiled-smoke", version: "0.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: BINARY,
			args: ["serve", "--mcp"],
			cwd: projectDir,
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1" },
		}),
	);
	const result = await client.callTool({
		name: "save_decision",
		arguments: {
			title: "Adopt reciprocal rank fusion for hybrid search",
			body:
				"Vector and BM25 rankings are fused with RRF (k=60); pure BM25 " +
				"remains the fallback when no embedding provider is available.",
			keywords: ["busca", "search", "fusão", "fusion", "rrf", "ranking"],
		},
	});
	await client.close();
	const payload = JSON.parse(
		(result.content as Array<{ text: string }>)[0]?.text ?? "{}",
	);
	if (typeof payload.id !== "string") {
		console.error("✗ save_decision over MCP");
		console.error(`  ${JSON.stringify(result)}`);
		process.exit(1);
	}
	console.log("✓ save_decision over MCP");
}

function compileUnlessPublished(): void {
	if (PUBLISHED_BINARY) return;
	const build = Bun.spawnSync(["bun", join(ROOT, "scripts", "build.ts")], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if (build.exitCode !== 0) process.exit(1);
}

compileUnlessPublished();
makeProject();
try {
	step("--version", cortex("--version"), CORTEX_VERSION);
	for (const origin of [
		"http://localhost:9",
		"https://github.com.attacker.tld",
	]) {
		refuses(
			`upgrade refuses ${origin}`,
			runCortex(["upgrade", "--check"], { CORTEX_RELEASE_BASE_URL: origin }),
			"refusing to upgrade from",
		);
	}
	step("init --yes", cortex("init", "--yes"), "Cortex initialized");
	step("index (embedded tree-sitter)", cortex("index"), "Indexed 1 file(s)");
	await saveDecisionOverMcp();
	step(
		"embed --missing (self-spawned worker)",
		cortex("embed", "--missing"),
		"Embedded 1 decision(s).",
	);
	step(
		"semantic search in Portuguese",
		cortex("search", "fusão de rankings na busca híbrida"),
		"Adopt reciprocal rank fusion",
	);
	// The other half of the same rule the origin refusals above prove: a variable
	// that chooses which program cortex executes is a test seam a source checkout
	// honours, and an installed binary must not. The path below is a script that
	// fails immediately, so a binary that took it could not embed at all.
	step(
		"an installed binary ignores CORTEX_EMBED_WORKER_PATH",
		runCortex(["embed", "--rebuild", "--yes"], {
			CORTEX_EMBED_WORKER_PATH: refusingWorker(),
		}),
		"Embedded 1 decision(s).",
	);
	step("doctor", cortex("doctor"), "");
} finally {
	rmSync(projectDir, { recursive: true, force: true });
}
console.log("compiled binary smoke: PASS");
