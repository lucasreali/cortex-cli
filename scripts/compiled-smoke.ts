// End-to-end proof that the compiled binary works without the Bun runtime or
// node_modules: version/help, init, code index (embedded tree-sitter WASM +
// grammar download), MCP serve with save_decision, real embedding through the
// self-spawned worker subcommand, semantic search and doctor.
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

const ROOT = new URL("..", import.meta.url).pathname;
const BINARY = join(ROOT, "dist", "cortex");

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

let projectDir = "";

function cortex(...argv: string[]): CommandResult {
	const environment = { ...process.env };
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

function git(...argv: string[]): void {
	const result = Bun.spawnSync(["git", ...argv], {
		cwd: projectDir,
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
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

const build = Bun.spawnSync(["bun", join(ROOT, "scripts", "build.ts")], {
	stdout: "inherit",
	stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(1);

makeProject();
try {
	step("--version", cortex("--version"), CORTEX_VERSION);
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
	step("doctor", cortex("doctor"), "");
} finally {
	rmSync(projectDir, { recursive: true, force: true });
}
console.log("compiled binary smoke: PASS");
