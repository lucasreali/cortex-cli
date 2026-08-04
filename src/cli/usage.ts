// One source for every usage line: main.ts prints them in --help and each
// command prints its own on a bad invocation. They drifted while there were
// two copies — cortex --help documented neither --json nor --force on upgrade.
export const USAGE = {
	init: "init [--yes]",
	serve: "serve --mcp",
	log: "log [--module M] [--since SHA] [--json]",
	why: "why <path|symbol> [--json]",
	search: "search <terms...> [--exact] [--json]",
	impact: "impact <id> [--depth N] [--json]",
	index: "index [--force]",
	sync: "sync [--json]",
	embed: "embed --missing | --rebuild [--yes]",
	doctor: "doctor [--json]",
	upgrade: "upgrade [--check [--json]] [--version V] [--force]",
	"prompt-hook": "prompt-hook",
	"embed-worker": "embed-worker",
	"embed-daemon": "embed-daemon [model]",
} as const;

export type CommandName = keyof typeof USAGE;

export function usageError(name: CommandName): number {
	console.error(`usage: cortex ${USAGE[name]}`);
	return 1;
}
