import { MarkedBlock } from "./marked-block";

export const CORTEX_BLOCK_BEGIN = "<!-- cortex:begin -->";
export const CORTEX_BLOCK_END = "<!-- cortex:end -->";

export const INSTRUCTIONS_BLOCK = new MarkedBlock(
	CORTEX_BLOCK_BEGIN,
	CORTEX_BLOCK_END,
);

export const CORTEX_INSTRUCTIONS_BODY = `## Cortex — decision memory

This project records its technical decisions with cortex (MCP server
\`cortex\`, tools: \`save_decision\`, \`save_session_summary\`,
\`get_context\`, \`get_decision\`, \`get_impact\`, \`search\`,
\`search_all_projects\`).

- Before proposing an approach or changing existing behavior, call
  \`get_context\` with your intent (or \`search\` with keywords) — a past
  decision may already govern this code. Read the ones that matter in full
  with \`get_decision\`.
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

More: https://github.com/lucasreali/cortex-cli#how-it-works`;

export const CORTEX_INSTRUCTIONS_BLOCK = INSTRUCTIONS_BLOCK.fence(
	CORTEX_INSTRUCTIONS_BODY,
);
