import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
	gatePrompt,
	type PromptGate,
	type PromptGateStore,
} from "@/app/prompt-gate";
import type { Decision } from "@/domain";
import { findNearestCortexRoot } from "@/storage/locate-store";
import { NodeRepository } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const BODY_LIMIT = 700;
const BUSY_TIMEOUT_MS = 1000;

const HIGH_NOTE =
	"Decisions from this project's persistent memory (Cortex) match this " +
	"prompt. Treat them as established context; check impact (get_impact " +
	"MCP tool or `cortex impact <id>`) before changing what they cover.";
const MEDIUM_NOTE =
	"This project's persistent memory (Cortex) may hold decisions related " +
	"to this prompt. Call the get_context MCP tool with a short intent (or " +
	"`cortex search`) to fetch them; ignore this if they are unrelated.";

// Claude Code UserPromptSubmit hook. LOAD-BEARING: it must never break the
// user's prompt. Every failure path — kill-switch, bad payload, no store,
// query error — exits 0 with no output; the store is opened read-only so the
// hook cannot create or migrate state.
export async function runPromptHook(
	_args: string[],
	cwd: string,
): Promise<number> {
	try {
		if (process.env.CORTEX_NO_PROMPT_HOOK === "1") return 0;
		if (process.stdin.isTTY) return printInstallHint();
		const payload = parsePayload(await Bun.stdin.text());
		if (payload.prompt === "") return 0;
		injectContext(payload.cwd ?? cwd, payload.prompt);
	} catch {}
	return 0;
}

function injectContext(startDir: string, prompt: string): void {
	const store = openNearestStore(startDir);
	if (!store) return;
	try {
		render(gatePrompt(store, prompt));
	} finally {
		store.close();
	}
}

function parsePayload(raw: string): { prompt: string; cwd: string | null } {
	try {
		const data = JSON.parse(raw) as { prompt?: unknown; cwd?: unknown };
		return {
			prompt: typeof data.prompt === "string" ? data.prompt : "",
			cwd: typeof data.cwd === "string" ? data.cwd : null,
		};
	} catch {
		return { prompt: "", cwd: null };
	}
}

type HookStore = PromptGateStore & { close(): void };

function openNearestStore(startDir: string): HookStore | null {
	const root = findNearestCortexRoot(startDir);
	if (!root) return null;
	const db = new Database(join(root, ".cortex", "decisions.db"), {
		readonly: true,
	});
	db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
	return {
		nodes: new NodeRepository(db),
		fts: new SearchRepository(db),
		close: () => db.close(),
	};
}

function render(gate: PromptGate): void {
	if (gate.tier === "none") return;
	const note = gate.tier === "high" ? HIGH_NOTE : MEDIUM_NOTE;
	const entries =
		gate.tier === "high"
			? gate.decisions.map(fullEntry).join("\n\n")
			: gate.decisions.map(titleEntry).join("\n");
	process.stdout.write(
		`<cortex_context note="${note}">\n${entries}\n</cortex_context>\n`,
	);
}

function fullEntry(decision: Decision): string {
	const module = decision.module ? `[${decision.module}] ` : "";
	const date = decision.createdAt.slice(0, 10);
	return (
		`## ${module}${decision.title}\n` +
		`(id ${decision.id}, ${date})\n` +
		truncate(decision.body, BODY_LIMIT)
	);
}

function titleEntry(decision: Decision): string {
	return `- ${decision.title} (${decision.id})`;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function printInstallHint(): number {
	console.log(
		"cortex prompt-hook is a Claude Code UserPromptSubmit hook; it reads",
	);
	console.log('{"prompt", "cwd"} JSON on stdin and prints decision context');
	console.log("only when the prompt matches this project's Cortex store.");
	console.log("\nRegister it in ~/.claude/settings.json:\n");
	console.log(
		JSON.stringify(
			{
				hooks: {
					UserPromptSubmit: [
						{ hooks: [{ type: "command", command: "cortex prompt-hook" }] },
					],
				},
			},
			null,
			2,
		),
	);
	console.log("\nKill-switch: CORTEX_NO_PROMPT_HOOK=1");
	return 0;
}
