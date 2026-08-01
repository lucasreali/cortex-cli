import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CortexRuntime } from "@/app/runtime";
import { symbolHint } from "@/app/symbol-hints";
import { printJson } from "@/cli/json";
import { withRuntime } from "@/cli/open-runtime";
import { success, warning } from "@/cli/style";
import { MINIMUM_KEYWORDS } from "@/domain";
import { GEMMA_MODEL } from "@/embedding/model";
import { modelsDir } from "@/embedding/models-dir";
import { computeDrift } from "@/indexer/code-indexer";
import { EXTRACTION_VERSION } from "@/indexer/extraction-version";
import { listSourceFiles } from "@/indexer/source-walker";
import { TsconfigAliases } from "@/indexer/tsconfig-aliases";
import { type OpenCodeRepository, openCodeRepository } from "@/storage/code-db";
import type { CodeRepository } from "@/storage/code-repository";
import { readConfig } from "@/storage/config";
import { CODE_SCHEMA_VERSION, SCHEMA_VERSION } from "@/storage/migrations";
import { errorMessage } from "@/support/errors";

const MINIMUM_RESOLUTION_RATE = 0.85;

export async function runDoctor(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { json: { type: "boolean", default: false } },
	});
	return withRuntime(cwd, async (runtime) => {
		const report = new DoctorReport();
		await checkConfig(runtime, report);
		checkAnchors(runtime, report);
		checkEmbeddings(runtime, report);
		checkKeywords(runtime, report);
		checkModelDownloaded(report);
		await checkCodeIndex(runtime, report);
		return values.json ? report.finishJson() : report.finish();
	});
}

interface DoctorCheck {
	level: "ok" | "warn";
	message: string;
}

class DoctorReport {
	private checks: DoctorCheck[] = [];

	ok(message: string): void {
		this.checks.push({ level: "ok", message });
	}

	warn(message: string): void {
		this.checks.push({ level: "warn", message });
	}

	finish(): number {
		for (const check of this.checks) {
			console.log(paint(check));
		}
		console.log(`\n${this.summary()}`);
		return this.exitCode();
	}

	finishJson(): number {
		printJson({ checks: this.checks, issues: this.issueCount() });
		return this.exitCode();
	}

	private issueCount(): number {
		return this.checks.filter((check) => check.level === "warn").length;
	}

	private exitCode(): number {
		return this.issueCount() === 0 ? 0 : 1;
	}

	private summary(): string {
		if (this.issueCount() === 0) return success("All checks passed.");
		return warning(`${this.issueCount()} issue(s) found.`);
	}
}

function paint(check: DoctorCheck): string {
	if (check.level === "ok") return success(check.message);
	return warning(check.message);
}

async function checkConfig(
	runtime: CortexRuntime,
	report: DoctorReport,
): Promise<void> {
	const config = await readConfig(runtime.cortexDir);
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
	if (!existsSync(join(runtime.cortexDir, "code.db"))) {
		report.warn("code index not built — run: cortex index");
		return;
	}
	const opened = openReadableCodeIndex(runtime, report);
	if (!opened) return;
	try {
		checkCodeVersions(opened.repository, report);
		checkCodeDrift(runtime, opened.repository, report);
		await checkImportResolution(runtime, opened.repository, report);
		checkSymbolAnchors(runtime, opened.repository, report);
	} finally {
		opened.database.close();
	}
}

// Diagnosing the index is doctor's job, so an unreadable code.db is a finding
// to report, not a reason to abort the remaining checks.
function openReadableCodeIndex(
	runtime: CortexRuntime,
	report: DoctorReport,
): OpenCodeRepository | null {
	try {
		return openCodeRepository(runtime.cortexDir);
	} catch (error) {
		const message = errorMessage(error);
		report.warn(`code index unreadable: ${message} — run: cortex index`);
		return null;
	}
}

function checkCodeVersions(
	repository: CodeRepository,
	report: DoctorReport,
): void {
	const stamped = repository.extractionVersion();
	if (stamped === EXTRACTION_VERSION) {
		report.ok(
			`code index: schema v${CODE_SCHEMA_VERSION}, extraction v${EXTRACTION_VERSION}`,
		);
		return;
	}
	report.warn(
		`code index extraction ${describeStamp(stamped)} != current v${EXTRACTION_VERSION} ` +
			`— stale content, run: cortex index`,
	);
}

function describeStamp(stamped: number | null): string {
	if (stamped === null) return "unstamped";
	return `v${stamped}`;
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

function checkSymbolAnchors(
	runtime: CortexRuntime,
	repository: CodeRepository,
	report: DoctorReport,
): void {
	const orphans = runtime.nodes
		.listActive()
		.flatMap((decision) =>
			decision.anchors
				.filter(
					(anchor) =>
						anchor.symbol !== "" &&
						!repository.hasSymbol(anchor.filePath, anchor.symbol),
				)
				.map((anchor) => ({ anchor, title: decision.title })),
		);
	if (orphans.length === 0) {
		report.ok("symbol anchors: all found in the code index");
		return;
	}
	for (const { anchor, title } of orphans) {
		const hint = symbolHint(repository, anchor.filePath, anchor.symbol);
		report.warn(
			`orphan symbol anchor: ${anchor.filePath}#${anchor.symbol} (${title})${hint}`,
		);
	}
}

function hasResolvableIntent(
	aliases: TsconfigAliases,
	specifier: string,
): boolean {
	if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
	return aliases.expand(specifier).length > 0;
}

function checkModelDownloaded(report: DoctorReport): void {
	if (existsSync(join(modelsDir(), GEMMA_MODEL.huggingFaceId))) {
		report.ok(`model downloaded: ${GEMMA_MODEL.huggingFaceId}`);
		return;
	}
	report.warn(
		`model not downloaded (${GEMMA_MODEL.huggingFaceId}) — first embed will fetch it`,
	);
}
