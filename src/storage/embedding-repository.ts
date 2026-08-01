import type { Database } from "bun:sqlite";

export interface StoredEmbedding {
	nodeId: string;
	modelId: string;
	dims: number;
	vector: Float32Array;
}

interface EmbeddingRow {
	node_id: string;
	model_id: string;
	dims: number;
	vector: Uint8Array;
}

export class EmbeddingRepository {
	constructor(private readonly db: Database) {}

	upsert(nodeId: string, modelId: string, vector: Float32Array): void {
		this.db
			.query(
				`INSERT INTO embeddings (node_id, model_id, dims, vector)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT (node_id) DO UPDATE SET
					model_id = excluded.model_id,
					dims = excluded.dims,
					vector = excluded.vector`,
			)
			.run(
				nodeId,
				modelId,
				vector.length,
				new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
			);
	}

	getByNodeId(nodeId: string): StoredEmbedding | null {
		const row = this.db
			.query<EmbeddingRow, [string]>(
				"SELECT node_id, model_id, dims, vector FROM embeddings WHERE node_id = ?",
			)
			.get(nodeId);
		if (!row) return null;
		return {
			nodeId: row.node_id,
			modelId: row.model_id,
			dims: row.dims,
			vector: toFloat32Array(row.vector),
		};
	}

	listActiveVectors(
		modelId: string,
	): Array<{ nodeId: string; vector: Float32Array }> {
		return this.db
			.query<{ node_id: string; vector: Uint8Array }, [string]>(
				`SELECT e.node_id, e.vector FROM embeddings e
				 JOIN nodes n ON n.id = e.node_id
				 WHERE e.model_id = ? AND n.kind = 'decision' AND n.status = 'active'`,
			)
			.all(modelId)
			.map((row) => ({
				nodeId: row.node_id,
				vector: toFloat32Array(row.vector),
			}));
	}

	listMissingNodeIds(modelId: string): string[] {
		return this.db
			.query<{ id: string }, [string]>(
				`SELECT n.id FROM nodes n
				 LEFT JOIN embeddings e ON e.node_id = n.id AND e.model_id = ?
				 WHERE n.kind = 'decision' AND n.status = 'active' AND e.node_id IS NULL
				 ORDER BY n.id`,
			)
			.all(modelId)
			.map((row) => row.id);
	}
}

// A Float32Array view requires a 4-byte-aligned offset, which a blob handed
// back as a view into a larger buffer does not guarantee; copying first costs
// one allocation and removes the RangeError from the query path.
function toFloat32Array(blob: Uint8Array): Float32Array {
	return new Float32Array(blob.slice().buffer);
}
