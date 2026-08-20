import { join } from "node:path";
import { LOCAL_DIRECTORY } from "@/storage/project-root";

export const ENABLE_VARIABLE = "CORTEX_QUERY_LOG";
export const DISABLE_VARIABLE = "CORTEX_NO_QUERY_LOG";
export const PATH_VARIABLE = "CORTEX_QUERY_LOG_PATH";

const QUERY_LOG_FILE = "queries.jsonl";

type Environment = Record<string, string | undefined>;

// Off by default, unlike the usefulness sidecar, and the difference is what is
// written down rather than a matter of taste: usefulness records ids and
// timestamps about decisions this repo already versions, while a query log
// records the text of the questions asked — proprietary content that would land
// in a file no repository's retention policy covers. A default-on record of
// that contradicts the on-device posture, so only an explicit opt-in turns it
// on. The disable flag wins over the enable flag for backwards compatibility: a
// machine that has been told to keep quiet must stay quiet when a later config
// sets the enable flag somewhere it cannot see.
export class QueryLogSettings {
	private constructor(
		readonly enabled: boolean,
		readonly path: string,
	) {}

	static from(
		cortexDir: string,
		environment: Environment = process.env,
	): QueryLogSettings {
		return new QueryLogSettings(
			recordingEnabled(environment),
			explicitPath(environment) ?? defaultQueryLogPath(cortexDir),
		);
	}
}

// Beside the usefulness log, in the one directory that is local, gitignored and
// safe to delete: a log of queries has exactly that lifetime.
export function defaultQueryLogPath(cortexDir: string): string {
	return join(cortexDir, LOCAL_DIRECTORY, QUERY_LOG_FILE);
}

function recordingEnabled(environment: Environment): boolean {
	if (environment[DISABLE_VARIABLE] === "1") return false;
	return environment[ENABLE_VARIABLE] === "1";
}

// An explicit path relocates the log; it never enables it. Someone who points
// the variable at a directory has said where, not whether.
function explicitPath(environment: Environment): string | null {
	const configured = environment[PATH_VARIABLE];
	if (configured === undefined || configured === "") return null;
	return configured;
}
