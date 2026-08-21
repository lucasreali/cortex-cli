import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Everything the suite writes outside a project goes under one directory that
// is removed when the process ends. Spawned CLIs, MCP servers and daemons
// inherit this environment, so without it the suite writes the developer's real
// ~/.cortex and their real HOME — and it left 7,000 temp directories behind in
// /tmp, one per mkdtemp that no afterEach ever cleaned up.
//
// TMPDIR is what makes that last part systemic: every mkdtempSync(tmpdir())
// call site in tests/ lands inside the run's own directory, so a test that
// forgets to clean up costs nothing, and no future one can reintroduce the leak.
const CACHE_ROOT = join(tmpdir(), "cortex-test-cache");
const runRoot = mkdtempSync(join(tmpdir(), "cortex-test-run-"));

// The grammar is fetched from GitHub and the model is hundreds of megabytes, so
// these two are the one thing that may outlive a run — in a cache of the
// suite's own, never the developer's. .github/workflows/ci.yml caches this path.
function cached(name: string): string {
	const directory = join(CACHE_ROOT, name);
	mkdirSync(directory, { recursive: true });
	return directory;
}

function scratch(name: string): string {
	const path = join(runRoot, name);
	mkdirSync(path, { recursive: true });
	return path;
}

process.env.CORTEX_GRAMMARS_DIR ??= cached("grammars");
process.env.CORTEX_MODELS_DIR ??= cached("models");
process.env.CORTEX_ONNX_DIR ??= cached("onnxruntime");
process.env.CORTEX_DAEMON_DIR ??= scratch("daemon");
process.env.CORTEX_PROJECTS_FILE ??= join(runRoot, "projects.json");
// Not ??=: HOME is always set, and it is the whole point that the real one is
// not what `cortex init` finds when it looks for ~/.claude or ~/.codex.
process.env.HOME = scratch("home");
process.env.TMPDIR = runRoot;

// A global afterAll rather than a process exit handler: `bun test` does not run
// the latter.
afterAll(() => rmSync(runRoot, { recursive: true, force: true }));
