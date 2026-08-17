import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CortexRuntime } from "@/app/runtime";
import { symbolHint } from "@/app/symbol-hints";
import { printJson } from "@/cli/json";
import { boundedMalformedLines } from "@/cli/malformed-files";
import { withRuntime } from "@/cli/open-runtime";
import { boundedSkippedLines } from "@/cli/skipped-sources";
import { success, warning } from "@/cli/style";
import { MINIMUM_KEYWORDS } from "@/domain";
import { GEMMA_MODEL } from "@/embedding/model";
import { modelsDir } from "@/embedding/models-dir";
import { computeDrift } from "@/indexer/code-indexer";
import { EXTRACTION_VERSION } from "@/indexer/extraction-version";
import { listSources, type SourceListing } from "@/indexer/source-walker";
import { TsconfigAliases } from "@/indexer/tsconfig-aliases";
import { QueryLog } from "@/querylog/query-log";
import { ENABLE_VARIABLE, QueryLogSettings } from "@/querylog/settings";
import { type RecentQueries, recentQueries } from "@/querylog/stats";
import { type OpenCodeRepository, openCodeRepository } from "@/storage/code-db";
import type { CodeRepository } from "@/storage/code-repository";
import { readConfigState } from "@/storage/config";
import { CODE_SCHEMA_VERSION, SCHEMA_VERSION } from "@/storage/migrations";
import {
	corruptRegistryBackups,
	projectsRegistryPath,
	readProjectRegistry,
} from "@/storage/project-registry";
import { ProjectRoot } from "@/storage/project-root";
import { errorMessage } from "@/support/errors";
import { UsefulnessEventLog } from "@/usefulness/event-log";

const MINIMUM_RESOLUTION_RATE = 0.85;

export async function runDoctor(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { json: { type: "boolean", default: false } },
	});
	return withRuntime(cwd, async (runtime) => {
		const report = new DoctorReport();
		await checkConfig(runtime, report);
		checkDecisionFiles(runtime, report);
		checkAnchors(runtime, report);
		checkEmbeddings(runtime, report);
		checkEmbeddingVintages(runtime, report);
		checkKeywords(runtime, report);
		checkUsefulness(runtime, report);
		checkQueryLog(runtime, report);
		checkModelDownloaded(report);
		checkProjectRegistry(report);
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
	const read = await readConfigState(runtime.cortexDir);
	if (read.state === "missing") {
		report.warn("config missing — run: cortex init");
		return;
	}
	if (read.state === "unreadable") {
		report.warn(
			`config at ${runtime.cortexDir}/config is not valid JSON — fix or delete it`,
		);
		return;
	}
	const { config } = read;
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

// Diagnosing is what doctor is for, so it pays for the full reconcile the
// other commands skip: dangling links and unreadable files are only visible to
// a pass that re-reads every present file.
function checkDecisionFiles(
	runtime: CortexRuntime,
	report: DoctorReport,
): void {
	const reconciled = runtime.decisions.resync();
	reportAbsent(runtime, report);
	for (const line of boundedMalformedLines(
		reconciled.malformed,
		(entry) => `decision file unreadable: ${entry.name} — ${entry.reason}`,
	)) {
		report.warn(line);
	}
	for (const edge of reconciled.dangling) {
		report.warn(
			`${edge.kind} link dropped: ${edge.from} → ${edge.to} is in no branch ` +
				"this store has seen",
		);
	}
	for (const entry of reconciled.multiplyReplaced) {
		report.warn(
			`superseded ${entry.by.length} times: ${entry.target} — by ${entry.by.join(", ")}`,
		);
	}
	if (reconciled.malformed.length + reconciled.dangling.length === 0) {
		report.ok("decision files: all readable, every link resolved");
	}
}

// Not a defect: a decision saved on a branch that is not checked out is
// exactly what `present` exists to record. It is worth naming so a decision
// that never merged stops being invisible.
function reportAbsent(runtime: CortexRuntime, report: DoctorReport): void {
	const absent = runtime.decisions.absent();
	if (absent.length === 0) return;
	report.ok(
		`${absent.length} decision(s) live on another branch: ` +
			absent.map((entry) => entry.title).join("; "),
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

// Counted over the live set only, like the pending check: a vector held by a
// superseded or off-branch decision is retained history, and `embed --missing`
// cannot reclaim it — reporting it would open an issue the user can never
// close. It becomes visible again when `present` flips back, which is when it
// starts to cost recall.
function checkEmbeddingVintages(
	runtime: CortexRuntime,
	report: DoctorReport,
): void {
	const vintages = runtime.embeddings.countsByModel();
	if (vintages.length === 0) return;
	const foreign = vintages.filter(
		(vintage) => vintage.modelId !== runtime.pinnedModelId,
	);
	if (foreign.length === 0) {
		report.ok(
			`embeddings: ${countVectors(vintages)} vector(s), all ${runtime.pinnedModelId}`,
		);
		return;
	}
	report.warn(
		`embeddings from another model: ${describeVintages(foreign)} — semantic ` +
			`search only reads ${runtime.pinnedModelId}, so those decisions answer ` +
			"through FTS alone — run: cortex embed --missing",
	);
}

function countVectors(vintages: Array<{ count: number }>): number {
	return vintages.reduce((total, vintage) => total + vintage.count, 0);
}

function describeVintages(
	vintages: Array<{ modelId: string; count: number }>,
): string {
	return vintages
		.map((vintage) => `${vintage.count} ${vintage.modelId}`)
		.join(", ");
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

// A fact, never an issue: an empty sidecar is the normal state of a fresh
// clone, and the only thing that could go wrong with it — losing it — costs
// nothing but the tiebreaker it feeds.
function checkUsefulness(runtime: CortexRuntime, report: DoctorReport): void {
	const log = new UsefulnessEventLog(
		ProjectRoot.at(runtime.repoRoot).usefulnessLogPath,
	);
	const events = log.events();
	if (events.length === 0) {
		report.ok("usefulness signal: nothing recorded yet");
		return;
	}
	report.ok(
		`usefulness signal: ${events.length} event(s), ${log.scores().size} ` +
			"decision(s) ranked by it — delete .cortex/local/ to reset",
	);
}

// Off is the documented default, so reporting it as an issue would ask the
// user to fix the posture the project chose. A log an earlier opt-in left
// behind is named even while recording is off: knowing the file is there is
// the difference between deleting it and forgetting it exists.
function checkQueryLog(runtime: CortexRuntime, report: DoctorReport): void {
	const log = new QueryLog(QueryLogSettings.from(runtime.cortexDir));
	const recent = recentQueries(log.entries());
	if (!log.enabled) {
		report.ok(`query log: off — ${offDetail(recent, log.path)}`);
		return;
	}
	if (recent.recorded === 0) {
		report.ok(`query log: on, nothing recorded yet — ${log.path}`);
		return;
	}
	report.ok(
		`query log: ${recent.empty} of your last ${recent.considered} queries ` +
			`returned nothing (${recent.recorded} recorded) — ${log.path}`,
	);
}

function offDetail(recent: RecentQueries, path: string): string {
	if (recent.recorded === 0) {
		return `no query text is recorded (set ${ENABLE_VARIABLE}=1 to record locally)`;
	}
	return `${recent.recorded} query(ies) recorded earlier are still at ${path} — delete the file to discard them`;
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
	const listing = listSources(runtime.repoRoot);
	reportSkippedSources(listing, report);
	const drift = computeDrift(listing, indexed);
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

// A skipped file contributes no symbols and never shows up as drift, so this is
// the only place it can be seen: without it, get_impact loses a file silently.
function reportSkippedSources(
	listing: SourceListing,
	report: DoctorReport,
): void {
	for (const line of boundedSkippedLines(listing.skipped)) {
		report.warn(line);
	}
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

// Every command registers its project before the checks run, so an unreadable
// registry that reaches here is one whose backup failed too — the file needs
// hands. A backup that is merely lying around is reported as a fact, not as an
// issue, the way off-branch decisions are.
function checkProjectRegistry(report: DoctorReport): void {
	const registered = readProjectRegistry();
	if (registered.state === "unreadable") {
		report.warn(
			`project registry at ${projectsRegistryPath()} is not valid JSON and ` +
				"could not be moved aside — fix or delete it, or cross-project " +
				"search only sees this project",
		);
		return;
	}
	reportRegistryBackups(report);
	const count = registered.state === "ok" ? registered.projects.length : 0;
	report.ok(`project registry: ${count} project(s) registered`);
}

function reportRegistryBackups(report: DoctorReport): void {
	const backups = corruptRegistryBackups();
	if (backups.length === 0) return;
	report.ok(
		`${backups.length} unreadable project registry(ies) kept aside: ` +
			`${backups.join(", ")} — restore or delete them`,
	);
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
