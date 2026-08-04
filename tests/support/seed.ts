import type { Database } from "bun:sqlite";
import { DecisionStore } from "@/decisions/decision-store";
import { saveDecisionFile } from "@/decisions/save";
import type { CreateDecisionInput, Decision } from "@/domain";
import { DecisionSyncRepository } from "@/storage/decision-sync-repository";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";

// Tests seed through the real write path: a decision that exists only as a row
// would be flipped to present = 0 by the next reconcile, so writing the file is
// not an incidental detail of saving — it is what saving means.
export function seedDecision(
	cortexDir: string,
	db: Database,
	input: CreateDecisionInput,
	context: SaveContext,
): Decision {
	const saved = saveDecisionFile(
		{
			store: DecisionStore.at(cortexDir),
			repository: new DecisionSyncRepository(db),
		},
		input,
		context,
	);
	const decision = new NodeRepository(db).getById(saved.id);
	if (!decision) throw new Error(`decision not stored: ${saved.id}`);
	return decision;
}
