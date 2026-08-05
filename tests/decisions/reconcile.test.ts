import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportExistingDecisions } from "@/decisions/bootstrap";
import { formatDecisionFile } from "@/decisions/decision-file";
import { DecisionStore } from "@/decisions/decision-store";
import {
	type ReconcileDependencies,
	type ReconcileReport,
	reconcileDecisions,
} from "@/decisions/reconcile";
import type { DecisionFile } from "@/domain";
import { openDecisionsDb } from "@/storage/connection";
import { DecisionSyncRepository } from "@/storage/decision-sync-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const FIRST = "019f0000-0000-7000-8000-000000000001";
const SECOND = "019f0000-0000-7000-8000-000000000002";
const THIRD = "019f0000-0000-7000-8000-000000000003";
const FOURTH = "019f0000-0000-7000-8000-000000000004";
const ELSEWHERE = "019f0000-0000-7000-8000-00000000000e";

let dir: string;
let db: Database;
let dependencies: ReconcileDependencies;
let nodes: NodeRepository;
let search: SearchRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-reconcile-"));
	db = openDecisionsDb(dir);
	migrate(db);
	dependencies = {
		store: DecisionStore.at(dir),
		repository: new DecisionSyncRepository(db),
	};
	nodes = new NodeRepository(db);
	search = new SearchRepository(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function decisionFile(overrides: Partial<DecisionFile> = {}): DecisionFile {
	return {
		id: FIRST,
		title: "Adotar JWT para autenticação",
		body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
		keywords: ["autenticação", "authentication", "jwt", "login", "token"],
		module: null,
		replaces: null,
		archives: null,
		dependsOn: [],
		conflictsWith: [],
		anchors: [],
		commitSha: null,
		commitDirty: false,
		provenance: "agent",
		createdAt: "2026-07-22T14:03:11.204Z",
		...overrides,
	};
}

function write(overrides: Partial<DecisionFile> = {}): DecisionFile {
	const file = decisionFile(overrides);
	dependencies.store.write(file);
	return file;
}

function remove(id: string): void {
	unlinkSync(dependencies.store.pathFor(id));
}

function reconcile(full = false): ReconcileReport {
	return reconcileDecisions(dependencies, { full });
}

function edgeRows(kind: string): Array<{ from_id: string; to_id: string }> {
	return db
		.query<{ from_id: string; to_id: string }, [string]>(
			"SELECT from_id, to_id FROM edges WHERE kind = ? ORDER BY from_id, to_id",
		)
		.all(kind);
}

function presenceOf(id: string): boolean | undefined {
	return dependencies.repository.listPresence().find((entry) => entry.id === id)
		?.present;
}

describe("reconcileDecisions imports new files", () => {
	test("inserts the node, its anchors and its search index row", () => {
		write({
			module: "auth",
			anchors: [{ filePath: "src/auth/service.ts", symbol: "Auth.login" }],
		});

		expect(reconcile().imported).toEqual([FIRST]);
		expect(nodes.getById(FIRST)?.anchors).toEqual([
			{ filePath: "src/auth/service.ts", symbol: "Auth.login" },
		]);
		expect(
			search.searchExact(["autenticação"]).map((hit) => hit.nodeId),
		).toEqual([FIRST]);
	});

	test("imports nothing on a machine where the session never happened", () => {
		write();
		reconcile();

		expect(edgeRows("BELONGS_TO")).toEqual([]);
		expect(edgeRows("GENERATED_IN")).toEqual([]);
	});

	test("a second run reports nothing and leaves the edges alone", () => {
		write({ id: SECOND });
		write({ dependsOn: [SECOND] });
		reconcile();

		expect(reconcile()).toEqual({
			imported: [],
			absent: [],
			restored: [],
			dangling: [],
			multiplyReplaced: [],
			malformed: [],
		});
		expect(edgeRows("DEPENDS_ON")).toEqual([{ from_id: FIRST, to_id: SECOND }]);
	});
});

describe("reconcileDecisions follows the branch", () => {
	beforeEach(() => {
		write();
		reconcile();
	});

	test("a decision whose file is gone is flagged, never deleted", () => {
		remove(FIRST);

		expect(reconcile().absent).toEqual([FIRST]);
		expect(presenceOf(FIRST)).toBe(false);
		expect(nodes.getById(FIRST)?.title).toBe("Adotar JWT para autenticação");
		expect(nodes.listActive()).toEqual([]);
	});

	test("a decision whose file returns comes back without being re-imported", () => {
		remove(FIRST);
		reconcile();
		write();

		const report = reconcile();

		expect(report.restored).toEqual([FIRST]);
		expect(report.imported).toEqual([]);
		expect(nodes.listActive().map((decision) => decision.id)).toEqual([FIRST]);
	});
});

describe("reconcileDecisions derives the versioned links", () => {
	test("a depends_on nobody knows is skipped and reported, never inserted", () => {
		write({ dependsOn: [ELSEWHERE] });

		const report = reconcile();

		expect(report.imported).toEqual([FIRST]);
		expect(report.dangling).toEqual([
			{ from: FIRST, kind: "DEPENDS_ON", to: ELSEWHERE },
		]);
		expect(edgeRows("DEPENDS_ON")).toEqual([]);
	});

	test("a replaces nobody knows is skipped and reported too", () => {
		write({ replaces: ELSEWHERE });

		expect(reconcile().dangling).toEqual([
			{ from: ELSEWHERE, kind: "REPLACED_BY", to: FIRST },
		]);
		expect(nodes.getById(FIRST)?.status).toBe("active");
	});

	test("a target in the store but not on this branch still links", () => {
		write({ id: SECOND });
		reconcile();
		remove(SECOND);
		reconcile();
		write({ dependsOn: [SECOND] });

		const report = reconcile();

		expect(report.dangling).toEqual([]);
		expect(edgeRows("DEPENDS_ON")).toEqual([{ from_id: FIRST, to_id: SECOND }]);
	});

	test("a file naming the same dependency twice yields one edge", () => {
		write({ id: SECOND });
		write({ dependsOn: [SECOND, SECOND] });

		reconcile();

		expect(edgeRows("DEPENDS_ON")).toEqual([{ from_id: FIRST, to_id: SECOND }]);
	});

	test("conflicts_with derives one directed edge from the declaring file", () => {
		write({ id: SECOND });
		write({ conflictsWith: [SECOND] });

		reconcile();

		expect(edgeRows("CONFLICTS_WITH")).toEqual([
			{ from_id: FIRST, to_id: SECOND },
		]);
		expect(nodes.getById(FIRST)?.status).toBe("active");
		expect(nodes.getById(SECOND)?.status).toBe("active");
	});

	test("a conflicts_with nobody knows is skipped and reported", () => {
		write({ conflictsWith: [ELSEWHERE] });

		expect(reconcile().dangling).toEqual([
			{ from: FIRST, kind: "CONFLICTS_WITH", to: ELSEWHERE },
		]);
		expect(edgeRows("CONFLICTS_WITH")).toEqual([]);
	});

	test("two files declaring each other keep both directed edges", () => {
		write({ conflictsWith: [SECOND] });
		write({ id: SECOND, conflictsWith: [FIRST] });

		reconcile();

		expect(edgeRows("CONFLICTS_WITH")).toEqual([
			{ from_id: FIRST, to_id: SECOND },
			{ from_id: SECOND, to_id: FIRST },
		]);
	});
});

describe("reconcileDecisions derives status from the present files", () => {
	test("the superseded decision is replaced, the replacement active", () => {
		write();
		write({ id: SECOND, replaces: FIRST });

		reconcile();

		expect(nodes.getById(FIRST)?.status).toBe("replaced");
		expect(nodes.getById(SECOND)?.status).toBe("active");
		expect(edgeRows("REPLACED_BY")).toEqual([
			{ from_id: FIRST, to_id: SECOND },
		]);
	});

	test("removing the replacement revives the decision it superseded", () => {
		write();
		write({ id: SECOND, replaces: FIRST });
		reconcile();

		remove(SECOND);
		reconcile();

		expect(nodes.getById(FIRST)?.status).toBe("active");
		expect(nodes.listActive().map((decision) => decision.id)).toEqual([FIRST]);
	});

	test("two branches superseding the same decision are both kept and reported", () => {
		write();
		write({ id: SECOND, replaces: FIRST });
		write({ id: THIRD, replaces: FIRST });

		const report = reconcile();

		expect(report.multiplyReplaced).toEqual([
			{ target: FIRST, by: [SECOND, THIRD] },
		]);
		expect(edgeRows("REPLACED_BY")).toEqual([
			{ from_id: FIRST, to_id: SECOND },
			{ from_id: FIRST, to_id: THIRD },
		]);
		expect(nodes.getById(FIRST)?.status).toBe("replaced");
	});

	test("an archived decision leaves search and recall without a successor", () => {
		write();
		write({ id: SECOND, archives: FIRST });

		reconcile();

		expect(nodes.getById(FIRST)?.status).toBe("archived");
		expect(edgeRows("ARCHIVED_BY")).toEqual([
			{ from_id: FIRST, to_id: SECOND },
		]);
		expect(nodes.listActive().map((decision) => decision.id)).toEqual([SECOND]);
		expect(
			search.searchExact(["autenticação"]).map((hit) => hit.nodeId),
		).toEqual([SECOND]);
	});

	test("removing the archiving file revives the decision it retired", () => {
		write();
		write({ id: SECOND, archives: FIRST });
		reconcile();

		remove(SECOND);
		reconcile();

		expect(nodes.getById(FIRST)?.status).toBe("active");
	});

	test("an archives nobody knows is skipped and reported", () => {
		write({ archives: ELSEWHERE });

		expect(reconcile().dangling).toEqual([
			{ from: ELSEWHERE, kind: "ARCHIVED_BY", to: FIRST },
		]);
		expect(nodes.getById(FIRST)?.status).toBe("active");
	});

	test("a decision both superseded and archived comes out replaced", () => {
		write();
		write({ id: SECOND, replaces: FIRST });
		write({ id: THIRD, archives: FIRST });

		const report = reconcile();

		expect(nodes.getById(FIRST)?.status).toBe("replaced");
		expect(report.multiplyReplaced).toEqual([
			{ target: FIRST, by: [SECOND, THIRD] },
		]);
	});
});

describe("reconcileDecisions and files it cannot read", () => {
	function corrupt(id: string): void {
		mkdirSync(dependencies.store.directory, { recursive: true });
		writeFileSync(dependencies.store.pathFor(id), "sem frontmatter\n");
	}

	test("an unreadable arrival is reported and no node is invented", () => {
		corrupt(FIRST);

		const report = reconcile();

		expect(report.imported).toEqual([]);
		expect(report.malformed).toEqual([
			{ name: `${FIRST}.md`, reason: "missing frontmatter fence" },
		]);
		expect(nodes.getById(FIRST)).toBeNull();
	});

	test("a decision whose file goes unreadable stays present, not absent", () => {
		write();
		write({ id: SECOND });
		reconcile();
		corrupt(FIRST);
		remove(SECOND);

		const report = reconcile();

		expect(report.absent).toEqual([SECOND]);
		expect(presenceOf(FIRST)).toBe(true);
		expect(nodes.listActive().map((decision) => decision.id)).toEqual([FIRST]);
	});

	test("a .md file whose name is not an id is reported, not ignored", () => {
		write();
		writeFileSync(join(dependencies.store.directory, "notes.md"), "hello\n");

		expect(reconcile(true).malformed).toEqual([
			{ name: "notes.md", reason: "filename is not a decision id" },
		]);
	});

	test("the cheap path trusts immutability; --full re-reads everything", () => {
		write();
		reconcile();
		corrupt(FIRST);

		expect(reconcile().malformed).toEqual([]);
		expect(reconcile(true).malformed).toEqual([
			{ name: `${FIRST}.md`, reason: "missing frontmatter fence" },
		]);
	});
});

describe("exportExistingDecisions", () => {
	function seedWithoutFiles(): void {
		dependencies.repository.transaction(() => {
			dependencies.repository.insertDecision(decisionFile(), null);
			dependencies.repository.insertDecision(
				decisionFile({ id: SECOND, replaces: FIRST, dependsOn: [] }),
				null,
			);
			dependencies.repository.insertVersionedEdge(FIRST, "REPLACED_BY", SECOND);
			dependencies.repository.applyStatuses([FIRST], []);
		});
	}

	test("writes every decision the store already holds, then reconciles quietly", () => {
		seedWithoutFiles();

		expect(exportExistingDecisions(dependencies)).toEqual([FIRST, SECOND]);
		expect(dependencies.store.listIds()).toEqual([FIRST, SECOND]);
		expect(reconcile()).toEqual({
			imported: [],
			absent: [],
			restored: [],
			dangling: [],
			multiplyReplaced: [],
			malformed: [],
		});
	});

	test("the exported files carry the links back on a rebuilt database", () => {
		seedWithoutFiles();
		exportExistingDecisions(dependencies);
		const exported = dependencies.store
			.listIds()
			.map((id) => dependencies.store.read(id));
		db.query("DELETE FROM edges").run();
		db.query("DELETE FROM nodes WHERE kind = 'decision'").run();
		db.query("DELETE FROM nodes_fts").run();

		reconcile();

		expect(exported.every((parse) => parse.ok)).toBe(true);
		expect(nodes.getById(FIRST)?.status).toBe("replaced");
		expect(edgeRows("REPLACED_BY")).toEqual([
			{ from_id: FIRST, to_id: SECOND },
		]);
	});

	test("exporting an empty store writes nothing", () => {
		expect(exportExistingDecisions(dependencies)).toEqual([]);
		expect(dependencies.store.listIds()).toEqual([]);
	});
});

describe("a store whose decisions directory never arrives", () => {
	test("everything it holds goes absent, and nothing is deleted", () => {
		write();
		reconcile();
		rmSync(dependencies.store.directory, { recursive: true, force: true });

		expect(reconcile().absent).toEqual([FIRST]);
		expect(nodes.getById(FIRST)).not.toBeNull();
		expect(nodes.listActive()).toEqual([]);
	});
});

describe("decision files round-trip through the reconciler unchanged", () => {
	test("what the store exports is what the writer would have written", () => {
		write({ id: SECOND });
		write({ id: THIRD });
		write({ id: FOURTH });
		const file = write({
			module: "auth",
			archives: FOURTH,
			dependsOn: [SECOND],
			conflictsWith: [THIRD],
			anchors: [{ filePath: "src/auth/service.ts", symbol: "Auth.login" }],
			commitSha: "ca43a65",
			commitDirty: true,
		});
		reconcile();

		expect(
			dependencies.repository.listExportRows().map(formatDecisionFile),
		).toContain(formatDecisionFile(file));
	});
});
