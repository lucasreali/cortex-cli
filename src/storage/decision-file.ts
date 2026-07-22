import { z } from "zod";
import type { Anchor, Decision, DecisionRecord } from "@/domain";

const frontmatterSchema = z.object({
	id: z.uuid(),
	title: z.string().min(1),
	status: z.enum(["active", "replaced"]).default("active"),
	module: z.string().min(1).nullish(),
	keywords: z.array(z.string().min(1)).default([]),
	anchors: z
		.array(
			z.object({
				file: z.string().min(1),
				symbol: z.string().min(1).optional(),
			}),
		)
		.default([]),
	depends_on: z.array(z.uuid()).default([]),
	replaces: z.uuid().nullish(),
	commit: z.string().min(1).nullish(),
	commit_dirty: z.boolean().default(false),
	provenance: z.enum(["agent", "human"]).default("agent"),
	props: z.record(z.string(), z.unknown()).nullish(),
	created_at: z.string().min(1),
});

type Frontmatter = z.infer<typeof frontmatterSchema>;

export function decisionFileName(decisionId: string): string {
	return `${decisionId}.md`;
}

export function serializeDecisionFile(record: DecisionRecord): string {
	const yaml = Bun.YAML.stringify(toFrontmatter(record), null, 2);
	return `---\n${yaml.trimEnd()}\n---\n\n${record.decision.body.trim()}\n`;
}

export function parseDecisionFile(
	content: string,
	fileName: string,
): DecisionRecord {
	const { yaml, body } = splitFrontmatter(content, fileName);
	const frontmatter = validateFrontmatter(yaml, fileName);
	requireMatchingFileName(frontmatter.id, fileName);
	return toRecord(frontmatter, body);
}

function splitFrontmatter(
	content: string,
	fileName: string,
): { yaml: unknown; body: string } {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
	if (!match) {
		throw new Error(`invalid decision file ${fileName}: missing frontmatter`);
	}
	try {
		return { yaml: Bun.YAML.parse(match[1] as string), body: trimBody(match) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid decision file ${fileName}: ${message}`);
	}
}

function trimBody(match: RegExpExecArray): string {
	return (match[2] as string).trim();
}

function validateFrontmatter(yaml: unknown, fileName: string): Frontmatter {
	const result = frontmatterSchema.safeParse(yaml);
	if (!result.success) {
		throw new Error(
			`invalid decision file ${fileName}: ${result.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	return result.data;
}

function requireMatchingFileName(id: string, fileName: string): void {
	if (fileName === decisionFileName(id)) return;
	throw new Error(
		`invalid decision file ${fileName}: frontmatter id ${id} does not match file name`,
	);
}

function toFrontmatter(record: DecisionRecord): Record<string, unknown> {
	const { decision } = record;
	return {
		id: decision.id,
		title: decision.title,
		status: decision.status,
		...(decision.module ? { module: decision.module } : {}),
		keywords: decision.keywords,
		...(decision.anchors.length > 0
			? { anchors: decision.anchors.map(toAnchorEntry) }
			: {}),
		...(record.dependsOn.length > 0 ? { depends_on: record.dependsOn } : {}),
		...(record.replaces ? { replaces: record.replaces } : {}),
		...(decision.commitSha ? { commit: decision.commitSha } : {}),
		...(decision.commitDirty ? { commit_dirty: true } : {}),
		provenance: decision.provenance,
		...(decision.props ? { props: decision.props } : {}),
		created_at: decision.createdAt,
	};
}

function toAnchorEntry(anchor: Anchor): Record<string, string> {
	if (anchor.symbol === "") return { file: anchor.filePath };
	return { file: anchor.filePath, symbol: anchor.symbol };
}

function toRecord(frontmatter: Frontmatter, body: string): DecisionRecord {
	return {
		decision: toDecision(frontmatter, body),
		dependsOn: frontmatter.depends_on,
		replaces: frontmatter.replaces ?? null,
	};
}

function toDecision(frontmatter: Frontmatter, body: string): Decision {
	return {
		id: frontmatter.id,
		title: frontmatter.title,
		body,
		keywords: frontmatter.keywords,
		module: frontmatter.module ?? null,
		status: frontmatter.status,
		commitSha: frontmatter.commit ?? null,
		commitDirty: frontmatter.commit_dirty,
		provenance: frontmatter.provenance,
		props: frontmatter.props ?? null,
		createdAt: frontmatter.created_at,
		anchors: frontmatter.anchors.map((anchor) => ({
			filePath: anchor.file,
			symbol: anchor.symbol ?? "",
		})),
	};
}
