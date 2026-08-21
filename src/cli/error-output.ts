import { flagsIn } from "./arguments";
import { failure } from "./style";
import { type CommandName, USAGE } from "./usage";

// Every failure this CLI prints goes through here, so that `--json` means the
// same thing on the error path as on the happy one: a caller that parses stdout
// gets a parseable object on stderr instead of a decorated sentence it has to
// scrape. The mode is read from argv rather than threaded through the commands
// because the failures that matter most — a throw main.ts catches, an
// uninitialized project, a usage error — all happen where no parsed argument
// exists yet.
//
// A command that cannot print JSON on success must not invent it on failure, so
// the usage line decides: it is already the one place that says which commands
// take the flag.
function jsonRequested(argv: readonly string[]): boolean {
	const [name, ...args] = argv;
	if (!name || !(name in USAGE)) return false;
	if (!USAGE[name as CommandName].includes("--json")) return false;
	return flagsIn(args).includes("--json");
}

export function reportFailure(
	message: string,
	argv: readonly string[] = process.argv.slice(2),
): void {
	if (!jsonRequested(argv)) {
		console.error(failure(message));
		return;
	}
	console.error(JSON.stringify({ error: message }, null, 2));
}

export function usageError(name: CommandName): number {
	reportFailure(`usage: cortex ${USAGE[name]}`);
	return 1;
}
