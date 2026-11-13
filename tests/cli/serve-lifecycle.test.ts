import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const FAKE_WORKER = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

let dir: string;
let env: Record<string, string | undefined>;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-serve-"));
	env = {
		...process.env,
		HOME: dir,
		CORTEX_NO_DAEMON: "1",
		CORTEX_EMBED_WORKER_PATH: FAKE_WORKER,
	};
	Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
	Bun.spawnSync(["bun", MAIN_PATH, "init"], { cwd: dir, env });
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function message(id: number, method: string, params: unknown): string {
	return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

// A client that crashes or is killed with -9 sends no signal and no MCP
// close — it only stops being the other end of the pipe. A private embedding
// worker is what kept the orphan alive, so the test makes the server spawn one.
test("the MCP server exits once its client closes stdin, worker and all", async () => {
	const server = Bun.spawn(["bun", MAIN_PATH, "serve", "--mcp"], {
		cwd: dir,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	server.stdin.write(
		message(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		}),
	);
	server.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
	);
	server.stdin.write(
		message(2, "tools/call", {
			name: "save_decision",
			arguments: {
				title: "Adotar JWT para autenticação",
				body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
				keywords: ["autenticação", "authentication", "jwt", "login", "token"],
			},
		}),
	);
	await server.stdin.flush();
	await Bun.sleep(1500);
	server.stdin.end();

	const outcome = await Promise.race([
		server.exited,
		Bun.sleep(8000).then(() => "still running"),
	]);
	if (outcome === "still running") server.kill();

	expect(outcome).toBe(0);
}, 20000);
