import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GEMMA_MODEL } from "@/embedding/model";
import { computeDrift } from "@/indexer/code-indexer";
import { listSourceFiles } from "@/indexer/source-walker";
import { TsconfigAliases } from "@/indexer/tsconfig-aliases";
import type { CortexRuntime } from "@/mcp/runtime";
import { CodeRepository } from "@/storage/code-repository";
import { readConfig } from "@/storage/config";
import { openCodeDb } from "@/storage/connection";
import { migrateCode, SCHEMA_VERSION } from "@/storage/migrations";
import { cortexDirOf, openInitializedRuntime } from "../open-runtime";

const MINIMUM_KEYWORDS = 5;
const MINIMUM_RESOLUTION_RATE = 0.85;

export async function runDoctor(_args: string[], cwd: string): Promise<number> {
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const report = new DoctorReport();
		await checkConfig(runtime, report);
		checkAnchors(runtime, report);
		checkEmbeddings(runtime, report);
		checkKeywords(runtime, report);
		checkModelDownloaded(report);
		await checkCodeIndex(runtime, report);
		return report.finish();
	} finally {
		runtime.dispose();
	}
}

class DoctorReport {
	private issues = 0;

	ok(message: string): void {
		console.log(`ok    ${message}`);
	}

	warn(message: string): void {
		this.issues++;
		console.log(`warn  ${message}`);
	}

	finish(): number {
		console.log(
			this.issues === 0
				? "\nAll checks passed."
				: `\n${this.issues} issue(s) found.`,
		);
		return this.issues === 0 ? 0 : 1;
	}
}

async function checkConfig(
	runtime: CortexRuntime,
	report: DoctorReport,
): Promise<void> {
	const config = await readConfig(cortexDirOf(runtime));
	if (!config) {
		report.warn("config missing — run: cortex init");
		return;
	}
	if (config.schema_version !== SCHEMA_VERSION) {
		report.warn(
			`schema version ${config.schema_version} != expected ${SCHEMA_VERSION}`,
		);
		return;
	}
	report.ok(
		`config: model ${config.model_id}, schema v${config.schema_version}`,
	);
}

function checkAnchors(runtime: CortexRuntime, report: DoctorReport): void {
	const orphans = runtime.nodes
		.listActive()
		.flatMap((decision) =>
			decision.anchors
				.filter(
					(anchor) => !existsSync(join(runtime.repoRoot, anchor.filePath)),
				)
				.map((anchor) => `${anchor.filePath} (${decision.title})`),
		);
	if (orphans.length === 0) {
		report.ok("anchors: all files exist in the working tree");
		return;
	}
	for (const orphan of orphans) {
		report.warn(`orphan anchor: ${orphan}`);
	}
}

function checkEmbeddings(runtime: CortexRuntime, report: DoctorReport): void {
	const pending = runtime.embeddings.listMissingNodeIds(runtime.pinnedModelId);
	if (pending.length === 0) {
		report.ok("embeddings: none pending");
		return;
	}
	report.warn(
		`${pending.length} decision(s) without embedding — run: cortex embed --missing`,
	);
}

function checkKeywords(runtime: CortexRuntime, report: DoctorReport): void {
	const deficient = runtime.nodes.listActiveWithFewKeywords(MINIMUM_KEYWORDS);
	if (deficient.length === 0) {
		report.ok(`keywords: all decisions have >= ${MINIMUM_KEYWORDS}`);
		return;
	}
	for (const entry of deficient) {
		report.warn(
			`fewer than ${MINIMUM_KEYWORDS} keywords: ${entry.title} (${entry.id})`,
		);
	}
}

async function checkCodeIndex(
	runtime: CortexRuntime,
	report: DoctorReport,
): Promise<void> {
	if (!existsSync(join(cortexDirOf(runtime), "code.db"))) {
		report.warn("code index not built — run: cortex index");
		return;
	}
	const database = openCodeDb(cortexDirOf(runtime));
	try {
		migrateCode(database);
		const repository = new CodeRepository(database);
		checkCodeDrift(runtime, repository, report);
		await checkImportResolution(runtime, repository, report);
	} finally {
		database.close();
	}
}

function checkCodeDrift(
	runtime: CortexRuntime,
	repository: CodeRepository,
	report: DoctorReport,
): void {
	const indexed = repository.listFiles();
	const drift = computeDrift(listSourceFiles(runtime.repoRoot), indexed);
	if (drift.added === 0 && drift.changed === 0 && drift.removed === 0) {
		report.ok(
			`code index: in sync with the working tree (${indexed.length} files)`,
		);
		return;
	}
	report.warn(
		`code index outdated: ${drift.added} new, ${drift.changed} changed, ` +
			`${drift.removed} deleted — run: cortex index`,
	);
}

async function checkImportResolution(
	runtime: CortexRuntime,
	repository: CodeRepository,
	report: DoctorReport,
): Promise<void> {
	const aliases = await TsconfigAliases.load(runtime.repoRoot);
	const resolvable = repository
		.listImports()
		.filter((entry) => hasResolvableIntent(aliases, entry.specifier));
	if (resolvable.length === 0) {
		report.ok("imports: none with resolvable intent");
		return;
	}
	const resolved = resolvable.filter((entry) => entry.toPath !== null).length;
	const rate = resolved / resolvable.length;
	const summary = `${resolved}/${resolvable.length} resolvable imports resolved (${(rate * 100).toFixed(1)}%)`;
	if (rate >= MINIMUM_RESOLUTION_RATE) {
		report.ok(`imports: ${summary}`);
		return;
	}
	report.warn(
		`imports: ${summary} — below 85%, check tsconfig paths or run: cortex index --force`,
	);
}

function hasResolvableIntent(
	aliases: TsconfigAliases,
	specifier: string,
): boolean {
	if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
	return aliases.expand(specifier).length > 0;
}

function checkModelDownloaded(report: DoctorReport): void {
	const modelsDir =
		process.env.CORTEX_MODELS_DIR ?? join(homedir(), ".cortex", "models");
	if (existsSync(join(modelsDir, GEMMA_MODEL.huggingFaceId))) {
		report.ok(`model downloaded: ${GEMMA_MODEL.huggingFaceId}`);
		return;
	}
	report.warn(
		`model not downloaded (${GEMMA_MODEL.huggingFaceId}) — first embed will fetch it`,
	);
}
