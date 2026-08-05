import {
	type Anchor,
	type DecisionFile,
	NODE_PROVENANCES,
	type NodeProvenance,
} from "@/domain";
import { errorMessage } from "@/support/errors";

export type DecisionFileParse =
	| { ok: true; file: DecisionFile }
	| { ok: false; reason: string };

interface Frontmatter {
	title: string;
	keywords: string[];
	module?: string;
	replaces?: string;
	depends_on?: string[];
	conflicts_with?: string[];
	anchors?: string[];
	commit?: string;
	dirty?: boolean;
	provenance: NodeProvenance;
	created_at: string;
}

const FENCE = "---\n";

export function formatDecisionFile(file: DecisionFile): string {
	return `${FENCE}${frontmatterOf(file).join("\n")}\n${FENCE}\n${file.body}\n`;
}

export function parseDecisionFile(
	id: string,
	source: string,
): DecisionFileParse {
	const split = splitFence(source.replaceAll("\r\n", "\n"));
	if (!split.ok) return split;
	const data = parseYaml(split.frontmatter);
	if (!data.ok) return data;
	const problem = frontmatterProblem(data.value, split.body);
	if (problem) return { ok: false, reason: problem };
	return {
		ok: true,
		file: toDecisionFile(id, data.value as unknown as Frontmatter, split.body),
	};
}

function frontmatterOf(file: DecisionFile): string[] {
	return [
		`title: ${scalar(file.title)}`,
		`keywords: ${flowSequence(file.keywords)}`,
		...omittable("module", file.module),
		...omittable("replaces", file.replaces),
		...omittableSequence("depends_on", file.dependsOn),
		...omittableSequence("conflicts_with", file.conflictsWith),
		...anchorLines(file.anchors),
		...commitLines(file),
		`provenance: ${scalar(file.provenance)}`,
		`created_at: ${scalar(file.createdAt)}`,
	];
}

// JSON is a subset of YAML 1.2 and every escape JSON.stringify emits is a
// legal double-quoted YAML escape, so quoting everything is both always
// correct and immune to implicit typing — a decision titled "no" must not come
// back as the boolean false.
function scalar(value: string): string {
	return JSON.stringify(value);
}

function flowSequence(values: string[]): string {
	return `[${values.map(scalar).join(", ")}]`;
}

function omittable(key: string, value: string | null): string[] {
	if (value === null) return [];
	return [`${key}: ${scalar(value)}`];
}

function omittableSequence(key: string, values: string[]): string[] {
	if (values.length === 0) return [];
	return [`${key}: ${flowSequence(values)}`];
}

function anchorLines(anchors: Anchor[]): string[] {
	if (anchors.length === 0) return [];
	return [
		"anchors:",
		...anchors.map((anchor) => `  - ${scalar(text(anchor))}`),
	];
}

// A dirty flag with no commit to be dirty against says nothing, so the two
// travel together or not at all.
function commitLines(file: DecisionFile): string[] {
	if (file.commitSha === null) return [];
	return [`commit: ${scalar(file.commitSha)}`, `dirty: ${file.commitDirty}`];
}

function text(anchor: Anchor): string {
	if (anchor.symbol === "") return anchor.filePath;
	return `${anchor.filePath}#${anchor.symbol}`;
}

type FenceSplit =
	| { ok: true; frontmatter: string; body: string }
	| { ok: false; reason: string };

// Searching for the first closing fence is safe even for a body containing a
// `---` rule: everything the writer emits inside the fence is a quoted scalar
// or list punctuation, so a bare `---` line can never occur there.
function splitFence(source: string): FenceSplit {
	if (!source.startsWith(FENCE)) {
		return { ok: false, reason: "missing frontmatter fence" };
	}
	const close = source.indexOf(`\n${FENCE}`, FENCE.length - 1);
	if (close === -1) {
		return { ok: false, reason: "unterminated frontmatter fence" };
	}
	return {
		ok: true,
		frontmatter: source.slice(FENCE.length, close + 1),
		body: source.slice(close + 1 + FENCE.length).trim(),
	};
}

type YamlParse =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; reason: string };

function parseYaml(frontmatter: string): YamlParse {
	try {
		const value = Bun.YAML.parse(frontmatter);
		if (!isRecord(value)) return { ok: false, reason: "empty frontmatter" };
		return { ok: true, value };
	} catch (error) {
		return { ok: false, reason: `invalid YAML: ${errorMessage(error)}` };
	}
}

// Shape only, never policy: the authoring minimums in createDecisionSchema are
// rules for the save tool, and enforcing them here would make a decision that
// predates them vanish from the branch it lives on. Unknown keys are ignored
// so a file written by a newer cortex still loads in an older one.
function frontmatterProblem(
	data: Record<string, unknown>,
	body: string,
): string | null {
	if (!isText(data.title)) return "title must be a non-empty string";
	if (body === "") return "body is empty";
	if (!isTextList(data.keywords)) return "keywords must be a list of strings";
	if (!isOptionalText(data.module)) return "module must be a string";
	if (!isOptionalText(data.replaces)) return "replaces must be a string";
	if (!isOptionalTextList(data.depends_on)) {
		return "depends_on must be a list of strings";
	}
	if (!isOptionalTextList(data.conflicts_with)) {
		return "conflicts_with must be a list of strings";
	}
	if (!isOptionalTextList(data.anchors)) {
		return "anchors must be a list of strings";
	}
	if (!isOptionalText(data.commit)) return "commit must be a string";
	if (data.dirty !== undefined && typeof data.dirty !== "boolean") {
		return "dirty must be a boolean";
	}
	if (!isProvenance(data.provenance)) {
		return `provenance must be one of ${NODE_PROVENANCES.join(", ")}`;
	}
	if (!isText(data.created_at)) return "created_at must be a non-empty string";
	return null;
}

function toDecisionFile(
	id: string,
	data: Frontmatter,
	body: string,
): DecisionFile {
	return {
		id,
		title: data.title,
		body,
		keywords: data.keywords,
		module: data.module ?? null,
		replaces: data.replaces ?? null,
		dependsOn: data.depends_on ?? [],
		conflictsWith: data.conflicts_with ?? [],
		anchors: (data.anchors ?? []).map(toAnchor),
		commitSha: data.commit ?? null,
		commitDirty: data.dirty === true,
		provenance: data.provenance,
		createdAt: data.created_at,
	};
}

// The last `#` wins, so a path that legitimately contains one still resolves;
// no `#` at all — or nothing after it — is the file-level anchor.
function toAnchor(entry: string): Anchor {
	const hash = entry.lastIndexOf("#");
	if (hash === -1) return { filePath: entry, symbol: "" };
	return { filePath: entry.slice(0, hash), symbol: entry.slice(hash + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isOptionalText(value: unknown): boolean {
	return value === undefined || isText(value);
}

function isTextList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isText);
}

function isOptionalTextList(value: unknown): boolean {
	return value === undefined || isTextList(value);
}

function isProvenance(value: unknown): value is NodeProvenance {
	return NODE_PROVENANCES.includes(value as NodeProvenance);
}
