import { Database } from "bun:sqlite";
import {
	gatePrompt,
	type PromptGate,
	type PromptGateStore,
} from "@/app/prompt-gate";
import type { Decision } from "@/domain";
import { NodeRepository } from "@/storage/node-repository";
import { ProjectRoot } from "@/storage/project-root";
import { SearchRepository } from "@/storage/search-repository";
import { parseJsonOrNull } from "@/support/json";
import {
	fenceSafe,
	PROMPT_FENCE_CLOSE,
	PROMPT_FENCE_OPEN,
} from "@/support/prompt-fence";
import { truncate } from "@/support/text";

const BODY_LIMIT = 700;
const BUSY_TIMEOUT_MS = 1000;
// The caller is a program that writes one JSON object and closes. A pipe that
// stays open is therefore never a slow prompt, it is a caller that will never
// finish — and this hook runs in front of a person waiting to type.
const STDIN_TIMEOUT_MS = 2000;
const STDIN_LIMIT_CHARACTERS = 1024 * 1024;

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
		const payload = parsePayload(await readStdin());
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

// Whatever a timeout or the size cap leaves behind is handed to the parser
// unchanged: a truncated payload is not valid JSON, and every unparseable
// payload already exits 0 in silence.
async function readStdin(): Promise<string> {
	const reader = Bun.stdin.stream().getReader();
	const deadline = setTimeout(() => void reader.cancel(), STDIN_TIMEOUT_MS);
	try {
		return await readUntilLimit(reader);
	} finally {
		clearTimeout(deadline);
	}
}

interface ByteReader {
	read(): Promise<{ done?: boolean; value?: Uint8Array }>;
	cancel(): Promise<unknown>;
}

async function readUntilLimit(reader: ByteReader): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	while (text.length < STDIN_LIMIT_CHARACTERS) {
		const chunk = await reader.read();
		if (chunk.done || !chunk.value) {
			return text + decoder.decode(new Uint8Array());
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	await reader.cancel();
	return text;
}

function parsePayload(raw: string): { prompt: string; cwd: string | null } {
	const data = parseJsonOrNull<{ prompt?: unknown; cwd?: unknown }>(raw);
	return {
		prompt: typeof data?.prompt === "string" ? data.prompt : "",
		cwd: typeof data?.cwd === "string" ? data.cwd : null,
	};
}

type HookStore = PromptGateStore & { close(): void };

function openNearestStore(startDir: string): HookStore | null {
	const project = ProjectRoot.nearest(startDir);
	if (!project) return null;
	// Read-only to SQLite is not read-only to the filesystem: reading a WAL
	// database still creates `-shm` (and `-wal`), so a `.cortex` the user cannot
	// write is a store this hook cannot open. That throws, and the caller exits
	// 0 in silence — deliberately. A hook that runs in front of every prompt has
	// no channel to complain on that would not become noise on every prompt.
	const db = new Database(project.decisionsDbPath, { readonly: true });
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
		`${PROMPT_FENCE_OPEN} note="${note}">\n${entries}\n${PROMPT_FENCE_CLOSE}\n`,
	);
}

// Every string that came out of a decision file is escaped, including the ones
// too short to spell a tag on their own: one rule a reader can check beats four
// per-field arguments about which length is safe.
function fullEntry(decision: Decision): string {
	const module = decision.module ? `[${fenceSafe(decision.module)}] ` : "";
	const date = fenceSafe(decision.createdAt.slice(0, 10));
	return (
		`## ${module}${fenceSafe(decision.title)}\n` +
		`(id ${decision.id}, ${date})\n` +
		truncate(fenceSafe(decision.body), BODY_LIMIT)
	);
}

function titleEntry(decision: Decision): string {
	return `- ${fenceSafe(decision.title)} (${decision.id})`;
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
