import type { Decision, DecisionRecord } from "@/domain";
import { parseDecisionFile } from "./decision-file";
import type {
	DecisionFileIndex,
	TrackedDecisionFile,
} from "./decision-file-index";
import type {
	DecisionFileContent,
	DecisionFileStore,
} from "./decision-file-store";
import type { EdgeRepository } from "./edge-repository";
import type { NodeRepository } from "./node-repository";

export interface DecisionSyncDependencies {
	files: DecisionFileStore;
	index: DecisionFileIndex;
	nodes: NodeRepository;
	edges: EdgeRepository;
	projectId: string;
}

interface FileChange {
	fileName: string;
	hash: string;
	record: DecisionRecord;
}

type Snapshot = Map<string, DecisionFileContent>;
type Tracked = Map<string, TrackedDecisionFile>;

export class DecisionSync {
	constructor(private readonly dependencies: DecisionSyncDependencies) {}

	async run(): Promise<void> {
		if (this.needsBootstrap()) return this.exportAllToFiles();
		await this.applyFileChanges();
	}

	// A db with decisions but no files dir predates the files-as-canonical
	// format: materialize the files once so git starts carrying them.
	private needsBootstrap(): boolean {
		if (this.dependencies.files.exists()) return false;
		return this.dependencies.nodes.listAllDecisions().length > 0;
	}

	private async exportAllToFiles(): Promise<void> {
		for (const decision of this.dependencies.nodes.listAllDecisions()) {
			const record = this.recordOf(decision);
			const { fileName, hash } = await this.dependencies.files.write(record);
			this.dependencies.index.record(fileName, hash, decision.id);
		}
	}

	private recordOf(decision: Decision): DecisionRecord {
		return {
			decision,
			dependsOn: this.dependencies.edges.dependsOnIds(decision.id),
			replaces: this.dependencies.edges.replacedSourceOf(decision.id),
		};
	}

	private async applyFileChanges(): Promise<void> {
		const snapshot = await this.dependencies.files.snapshot();
		const tracked = this.dependencies.index.all();
		const changes = parseChanges(snapshot, tracked);
		this.removeDeleted(snapshot, tracked, changedNodeIds(changes));
		this.applyChanges(changes);
	}

	private removeDeleted(
		snapshot: Snapshot,
		tracked: Tracked,
		survivors: Set<string>,
	): void {
		for (const [fileName, file] of tracked) {
			if (snapshot.has(fileName)) continue;
			if (!survivors.has(file.nodeId)) {
				this.dependencies.nodes.deleteDecision(file.nodeId);
			}
			this.dependencies.index.remove(fileName);
		}
	}

	private applyChanges(changes: FileChange[]): void {
		for (const change of changes) {
			this.dependencies.nodes.restoreDecision(
				change.record,
				this.dependencies.projectId,
			);
			this.dependencies.index.record(
				change.fileName,
				change.hash,
				change.record.decision.id,
			);
		}
	}
}

function parseChanges(snapshot: Snapshot, tracked: Tracked): FileChange[] {
	const changes: FileChange[] = [];
	for (const [fileName, file] of snapshot) {
		if (tracked.get(fileName)?.hash === file.hash) continue;
		changes.push({
			fileName,
			hash: file.hash,
			record: parseDecisionFile(file.content, fileName),
		});
	}
	// Ascending UUIDv7 order: DEPENDS_ON and replaces targets are always older
	// ids, so they exist by the time an edge pointing at them is inserted.
	return changes.sort((a, b) =>
		a.record.decision.id.localeCompare(b.record.decision.id),
	);
}

function changedNodeIds(changes: FileChange[]): Set<string> {
	return new Set(changes.map((change) => change.record.decision.id));
}
