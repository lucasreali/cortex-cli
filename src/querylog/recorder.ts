import type { AskedQuery } from "./entry";
import type { QueryLog } from "./query-log";

// The ranking a fixture would assert on is its head: the tail of a long result
// list says nothing an evaluation case is about, and every id kept is one more
// thing the log holds about a query.
const RECORDED_IDS_LIMIT = 10;

// What the query surfaces call. One line per query — a query asked twice is
// twice the traffic, which is the whole point of a traffic log and the one way
// it differs from the usefulness recorder's once-per-session claim.
export class QueryRecorder {
	constructor(
		private readonly log: QueryLog,
		private readonly session: string,
	) {}

	record(query: AskedQuery, resultIds: string[]): void {
		this.log.append({
			...query,
			session: this.session,
			at: new Date().toISOString(),
			results: resultIds.length,
			ids: resultIds.slice(0, RECORDED_IDS_LIMIT),
		});
	}
}
