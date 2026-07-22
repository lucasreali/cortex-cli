import type { CreateDecisionInput, Decision, DecisionRecord } from "@/domain";
import type { CortexRuntime } from "./runtime";

export async function persistDecision(
	runtime: CortexRuntime,
	input: CreateDecisionInput,
): Promise<Decision> {
	const context = runtime.saveContext();
	const decision = input.replaces
		? runtime.nodes.replaceDecision(input.replaces, input, context)
		: runtime.nodes.createDecision(input, context);
	await writeThrough(runtime, decision, input);
	runtime.queue?.enqueue(decision.id);
	runtime.semanticSearch.invalidate();
	return decision;
}

async function writeThrough(
	runtime: CortexRuntime,
	decision: Decision,
	input: CreateDecisionInput,
): Promise<void> {
	await writeRecord(runtime, {
		decision,
		dependsOn: input.depends_on ?? [],
		replaces: input.replaces ?? null,
	});
	if (input.replaces) await rewriteReplaced(runtime, input.replaces);
}

async function rewriteReplaced(
	runtime: CortexRuntime,
	replacedId: string,
): Promise<void> {
	const replaced = runtime.nodes.getById(replacedId);
	if (!replaced) return;
	await writeRecord(runtime, recordOf(runtime, replaced));
}

function recordOf(runtime: CortexRuntime, decision: Decision): DecisionRecord {
	return {
		decision,
		dependsOn: runtime.edges.dependsOnIds(decision.id),
		replaces: runtime.edges.replacedSourceOf(decision.id),
	};
}

async function writeRecord(
	runtime: CortexRuntime,
	record: DecisionRecord,
): Promise<void> {
	const { fileName, hash } = await runtime.decisionFiles.write(record);
	runtime.decisionFileIndex.record(fileName, hash, record.decision.id);
}
