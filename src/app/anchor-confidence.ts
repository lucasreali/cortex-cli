import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	ANCHOR_CONFIDENCES,
	type Anchor,
	type AnchorConfidence,
	type Decision,
} from "@/domain";
import type { CodeRepository } from "@/storage/code-repository";
import type { SymbolTable } from "@/storage/symbol-table";
import { accessCodeIndex } from "./code-index-access";
import type { CortexRuntime } from "./runtime";

export interface ResolvedAnchor extends Anchor {
	confidence: AnchorConfidence;
}

// A decision whose anchors carry their resolution. Structurally a Decision, so
// every consumer that only reads title, status or id keeps working, and the
// ones that read anchors get the label for free.
export interface AnchoredDecision extends Decision {
	anchors: ResolvedAnchor[];
}

export interface AnchorResolver {
	label(decision: Decision): AnchoredDecision;
}

export type AnchorResolutionDependencies = Pick<
	CortexRuntime,
	"repoRoot" | "codeIndex"
>;

export function indexedAnchorResolver(
	repoRoot: string,
	code: CodeRepository,
): AnchorResolver {
	return new IndexedAnchors(repoRoot, code);
}

// The code index could not be consulted, so nothing here is a claim about the
// code: every anchor comes back unjudged rather than wrongly downgraded.
export function unjudgedAnchorResolver(): AnchorResolver {
	return {
		label: (decision) => ({
			...decision,
			anchors: decision.anchors.map((anchor) => ({
				...anchor,
				confidence: "unknown" as const,
			})),
		}),
	};
}

export async function labelAnchors(
	dependencies: AnchorResolutionDependencies,
	decisions: Decision[],
): Promise<AnchoredDecision[]> {
	const resolver = await resolverFor(dependencies, decisions);
	return decisions.map((decision) => resolver.label(decision));
}

export async function anchorsByDecision(
	dependencies: AnchorResolutionDependencies,
	decisions: Decision[],
): Promise<Map<string, ResolvedAnchor[]>> {
	const labelled = await labelAnchors(dependencies, decisions);
	return new Map(
		labelled.map((decision) => [decision.id, decision.anchors] as const),
	);
}

export function strongestConfidence(
	anchors: ResolvedAnchor[],
): AnchorConfidence | null {
	const ranked = [...anchors].sort(
		(one, other) => rankOf(one.confidence) - rankOf(other.confidence),
	);
	return ranked[0]?.confidence ?? null;
}

function rankOf(confidence: AnchorConfidence): number {
	return ANCHOR_CONFIDENCES.indexOf(confidence);
}

// Reading the code index means reconciling it, so an unanchored payload must
// not pay for it: the resolver it gets is never asked anything.
async function resolverFor(
	dependencies: AnchorResolutionDependencies,
	decisions: Decision[],
): Promise<AnchorResolver> {
	if (decisions.every((decision) => decision.anchors.length === 0)) {
		return unjudgedAnchorResolver();
	}
	const access = await accessCodeIndex(dependencies.codeIndex);
	if (!access.ok) return unjudgedAnchorResolver();
	return new IndexedAnchors(dependencies.repoRoot, access.code);
}

class IndexedAnchors implements AnchorResolver {
	private symbols: SymbolTable | null = null;

	constructor(
		private readonly repoRoot: string,
		private readonly code: CodeRepository,
	) {}

	label(decision: Decision): AnchoredDecision {
		return {
			...decision,
			anchors: decision.anchors.map((anchor) => ({
				...anchor,
				confidence: this.confidenceOf(anchor),
			})),
		};
	}

	private confidenceOf(anchor: Anchor): AnchorConfidence {
		if (this.declaresSymbol(anchor)) return "exact";
		if (this.symbolLivesElsewhere(anchor)) return "name_only";
		if (!this.fileInWorkingTree(anchor)) return "unresolved";
		if (this.symbolIsGone(anchor)) return "unresolved";
		return "file_only";
	}

	private declaresSymbol(anchor: Anchor): boolean {
		if (anchor.symbol === "") return false;
		return this.code.hasSymbol(anchor.filePath, anchor.symbol);
	}

	// One read of the symbol table serves every anchor this resolver grades,
	// where a lookup per anchor rescans and re-normalizes the whole table each
	// time. Read on the first anchor that needs it, so a payload whose anchors
	// all resolve exactly never pays for it.
	private symbolLivesElsewhere(anchor: Anchor): boolean {
		if (anchor.symbol === "") return false;
		this.symbols ??= this.code.symbolTable();
		return this.symbols.locationsOf(anchor.symbol).length > 0;
	}

	private fileInWorkingTree(anchor: Anchor): boolean {
		return existsSync(join(this.repoRoot, anchor.filePath));
	}

	// The indexer covers TS/JS only, so a symbol it cannot find in a file it
	// never read is unverified rather than gone. A symbol missing from a file
	// the index does hold is a real miss.
	private symbolIsGone(anchor: Anchor): boolean {
		if (anchor.symbol === "") return false;
		return this.code.getFile(anchor.filePath) !== null;
	}
}
