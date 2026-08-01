// Bun instruments only the modules loaded in-process, so a source file that is
// exercised through a spawned CLI/MCP subprocess — or one with no test at all —
// is absent from the report rather than reported at 0%. The 100% threshold
// cannot see those files; this audit makes their absence deliberate.
import { relative } from "node:path";

const LCOV_PATH = process.env.CORTEX_LCOV ?? "coverage/lcov.info";

// Exercised end-to-end by spawning a real process (tests/cli, tests/mcp,
// scripts/compiled-smoke.ts), which no in-process profiler can observe.
const SUBPROCESS_COVERED = [
	"src/cli/commands/code-index.ts",
	"src/cli/commands/doctor.ts",
	"src/cli/commands/embed-all.ts",
	"src/cli/commands/embed-daemon.ts",
	"src/cli/commands/embed-worker.ts",
	"src/cli/commands/embed.ts",
	"src/cli/commands/impact.ts",
	"src/cli/commands/init.ts",
	"src/cli/commands/log.ts",
	"src/cli/commands/prompt-hook.ts",
	"src/cli/commands/search.ts",
	"src/cli/commands/serve.ts",
	"src/cli/commands/upgrade.ts",
	"src/cli/commands/why.ts",
	"src/cli/json.ts",
	"src/cli/main.ts",
	"src/cli/open-runtime.ts",
	"src/cli/style.ts",
	"src/embedding/daemon/main.ts",
	"src/embedding/worker.ts",
	"src/mcp/runtime-registry.ts",
	"src/mcp/server.ts",
	"src/mcp/tools/annotations.ts",
	"src/mcp/tools/get-context.ts",
	"src/mcp/tools/get-impact.ts",
	"src/mcp/tools/project-scope.ts",
	"src/mcp/tools/results.ts",
	"src/mcp/tools/save-decision.ts",
	"src/mcp/tools/search.ts",
	"src/storage/locate-store.ts",
];

// Types and interfaces only: nothing survives type erasure to instrument.
const TYPE_ONLY = ["src/embedding/protocol.ts", "src/embedding/provider.ts"];

function toRepoPath(file: string): string {
	if (!file.startsWith("/")) return file;
	return relative(process.cwd(), file);
}

async function instrumentedSources(): Promise<Set<string>> {
	const lcov = Bun.file(LCOV_PATH);
	if (!(await lcov.exists())) {
		console.error(`✗ ${LCOV_PATH} not found`);
		console.error("  run: bun test --coverage --coverage-reporter=lcov");
		process.exit(1);
	}
	const covered = (await lcov.text())
		.split("\n")
		.filter((line) => line.startsWith("SF:"))
		.map((line) => toRepoPath(line.slice(3).trim()))
		.filter((file) => file.startsWith("src/"));
	return new Set(covered);
}

async function declaredSources(): Promise<Set<string>> {
	const files = await Array.fromAsync(new Bun.Glob("src/**/*.ts").scan("."));
	return new Set(files.filter((file) => !file.endsWith(".d.ts")));
}

function report(title: string, files: string[], hint: string): boolean {
	if (files.length === 0) return true;
	console.error(`✗ ${title}`);
	for (const file of files) console.error(`    ${file}`);
	console.error(`  ${hint}`);
	return false;
}

const instrumented = await instrumentedSources();
const declared = await declaredSources();
const exempt = new Set([...SUBPROCESS_COVERED, ...TYPE_ONLY]);

const unmeasured = [...declared]
	.filter((file) => !instrumented.has(file))
	.filter((file) => !exempt.has(file))
	.sort();

const stale = [...exempt]
	.filter((file) => instrumented.has(file) || !declared.has(file))
	.sort();

const measured = report(
	"source files missing from the coverage report",
	unmeasured,
	"cover them in-process, or add them to scripts/coverage-audit.ts under the list that states why they cannot be",
);
const accurate = report(
	"stale exemptions in scripts/coverage-audit.ts",
	stale,
	"these files are now instrumented or gone — drop them from the list",
);

if (!measured || !accurate) process.exit(1);

console.log(
	`✓ coverage audit: ${instrumented.size} instrumented at 100%, ${exempt.size} exempt`,
);
