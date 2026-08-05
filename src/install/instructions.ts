export const CORTEX_BLOCK_BEGIN = "<!-- cortex:begin -->";
export const CORTEX_BLOCK_END = "<!-- cortex:end -->";

export const CORTEX_INSTRUCTIONS_BLOCK = `${CORTEX_BLOCK_BEGIN}
## Cortex — decision memory

This project records its technical decisions with cortex (MCP server
\`cortex\`, tools: \`save_decision\`, \`save_session_summary\`,
\`get_context\`, \`get_impact\`, \`search\`, \`search_all_projects\`).

- Before proposing an approach or changing existing behavior, call
  \`get_context\` with your intent (or \`search\` with keywords) — a past
  decision may already govern this code.
- Before reworking code a decision anchors, call \`get_impact\` with the
  decision id to see everything the change touches.
- When the user confirms a non-obvious decision, save it with
  \`save_decision\`.
- When the session ends (or a milestone lands), persist an
  "Implemented / Decisions / Open" narrative with \`save_session_summary\`
  — the "Open" section is how the next session recovers unfinished work.
- Decision files live in \`.cortex/decisions/\` and are committed with the
  code they explain.
- If semantic search returns nothing useful, embeddings may be missing —
  suggest running \`cortex embed --missing\`.

More: https://github.com/lucasreali/cortex-cli#how-it-works
${CORTEX_BLOCK_END}`;

export type BlockUpsert =
	| {
			content: string;
			action: "created" | "appended" | "updated" | "unchanged";
	  }
	| { action: "skipped-malformed" };

export function upsertMarkedBlock(
	existing: string | null,
	block: string,
): BlockUpsert {
	if (existing === null) return { content: `${block}\n`, action: "created" };
	const begin = existing.indexOf(CORTEX_BLOCK_BEGIN);
	if (begin === -1) return appendBlock(existing, block);
	const endMarker = existing.indexOf(CORTEX_BLOCK_END, begin);
	if (endMarker === -1) return { action: "skipped-malformed" };
	const end = endMarker + CORTEX_BLOCK_END.length;
	const content = existing.slice(0, begin) + block + existing.slice(end);
	if (content === existing) return { content, action: "unchanged" };
	return { content, action: "updated" };
}

function appendBlock(existing: string, block: string): BlockUpsert {
	const body = existing.trimEnd();
	if (body === "") return { content: `${block}\n`, action: "created" };
	return { content: `${body}\n\n${block}\n`, action: "appended" };
}
