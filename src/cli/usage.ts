// One source for every usage line: main.ts prints them in --help, each command
// prints its own on a bad invocation, and error-output.ts reads them to decide
// whether a command speaks --json. They drifted while there were two copies —
// cortex --help documented neither --json nor --force on upgrade.
export const USAGE = {
	init: "init [--yes]",
	install: "install [--yes] [--target T] [--git-hooks [--uninstall]]",
	serve: "serve --mcp",
	log: "log [--module M] [--since SHA] [--json]",
	why: "why <path|symbol> [--json]",
	search: "search <terms...> [--exact] [--all-projects] [--json]",
	impact: "impact <id> [--depth N] [--json]",
	index: "index [--force]",
	sync: "sync [--json]",
	embed: "embed --missing | --rebuild [--yes] | --fetch-model",
	doctor: "doctor [--json]",
	trust: "trust [--revoke]",
	benchmark: "benchmark [--limit N] [--write] [--json]",
	upgrade: "upgrade [--check [--json]] [--version V] [--force]",
	"prompt-hook": "prompt-hook",
	"git-hook": "git-hook <event> [git arguments...]",
	"embed-worker": "embed-worker",
	"embed-daemon": "embed-daemon [model]",
} as const;

export type CommandName = keyof typeof USAGE;
