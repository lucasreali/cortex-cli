import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GEMMA_MODEL } from "@/embedding/model";
import type { CortexRuntime } from "@/mcp/runtime";
import { readConfig } from "@/storage/config";
import { SCHEMA_VERSION } from "@/storage/migrations";
import { cortexDirOf, openInitializedRuntime } from "../open-runtime";

const MINIMUM_KEYWORDS = 5;

export async function runDoctor(_args: string[], cwd: string): Promise<number> {
	const runtime = openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const report = new DoctorReport();
		await checkConfig(runtime, report);
		checkAnchors(runtime, report);
		await checkEmbeddings(runtime, report);
		checkKeywords(runtime, report);
		checkModelDownloaded(report);
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

async function checkEmbeddings(
	runtime: CortexRuntime,
	report: DoctorReport,
): Promise<void> {
	const config = await readConfig(cortexDirOf(runtime));
	const modelId = config?.model_id ?? GEMMA_MODEL.modelId;
	const pending = runtime.embeddings.listMissingNodeIds(modelId);
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
