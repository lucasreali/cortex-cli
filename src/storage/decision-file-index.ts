import type { Database } from "bun:sqlite";

export interface TrackedDecisionFile {
	hash: string;
	nodeId: string;
}

export class DecisionFileIndex {
	constructor(private readonly db: Database) {}

	all(): Map<string, TrackedDecisionFile> {
		const rows = this.db
			.query<{ file_name: string; hash: string; node_id: string }, []>(
				"SELECT file_name, hash, node_id FROM decision_files",
			)
			.all();
		return new Map(
			rows.map((row) => [
				row.file_name,
				{ hash: row.hash, nodeId: row.node_id },
			]),
		);
	}

	record(fileName: string, hash: string, nodeId: string): void {
		this.db
			.query(
				`INSERT INTO decision_files (file_name, hash, node_id) VALUES (?, ?, ?)
				 ON CONFLICT(file_name) DO UPDATE SET hash = excluded.hash, node_id = excluded.node_id`,
			)
			.run(fileName, hash, nodeId);
	}

	remove(fileName: string): void {
		this.db
			.query("DELETE FROM decision_files WHERE file_name = ?")
			.run(fileName);
	}
}
