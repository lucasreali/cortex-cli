# Cortex

Persistent decision memory for coding agents. Cortex records the technical
decisions made while you and your agent work on a repository — what was
chosen, why, and which files it governs — and makes them searchable by
meaning, not just by keyword, from any later session.

Decisions live in `.cortex/decisions.db` (SQLite, local to the machine —
`cortex init` gitignores the whole `.cortex/` directory).
Semantic search runs fully local: EmbeddingGemma-300m quantized, via WASM in
a dedicated subprocess — no native dependencies, no runtime network calls
beyond the one-time model download to `~/.cortex/models/`.

## Requirements

- [Bun](https://bun.com) 1.3+
- git (project identity and head tracking)

## Setup

```bash
bun install
bun link        # exposes the `cortex` binary

cd your-project
cortex init     # creates .cortex/, runs migrations, writes config
```

Then register the MCP server with your agent:

```bash
claude mcp add cortex -- cortex serve --mcp
```

## How it works

The agent gets four tools:

| Tool | Purpose |
|---|---|
| `save_decision` | Record a decision: title, rationale, keywords (PT/EN), optional module, file/symbol anchors, `depends_on` links and `replaces` |
| `get_context` | Semantic search by intent ("como autenticamos usuários?") or recent active decisions |
| `get_impact` | Everything affected by changing a decision — dependency links walked both ways |
| `search` | Keyword search (accent-insensitive FTS) with optional semantic ranking |

Saves are transactional (decision + anchors + links + full-text row);
embeddings happen asynchronously off the save path and degrade to full-text
search whenever the model is unavailable.

## CLI

```bash
cortex log [--module M] [--since SHA]   # active decisions, newest first
cortex why <path>                       # decisions anchored to a file or directory
cortex search <terms...> [--exact]      # search with score and origin
cortex impact <id>                      # indented dependency tree
cortex index [--force]                  # (re)build the code index incrementally
cortex embed --missing | --rebuild      # fill or rebuild the vector index
cortex doctor                           # config, anchors, embeddings, model, code index
```

## Passive recall (Claude Code hook)

`cortex prompt-hook` makes recall passive: registered as a `UserPromptSubmit`
hook, it reads the `{prompt, cwd}` JSON Claude Code pipes on stdin, matches
prompt terms against the store of the nearest `.cortex/` above `cwd`, and
prints a `<cortex_context>` block only on a verified match:

- **high** — a term hits a decision's curated keywords → injects the
  decisions themselves (title + size-capped body);
- **medium** — a term hits only a decision title → injects titles/ids and
  points the agent at `get_context`;
- anything else is a silent no-op, so unrelated prompts cost nothing.

The gate is pure FTS (no embedding model on this path, ~100ms) and read-only;
any failure exits 0 with no output, so the hook can never break a prompt.
Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "cortex prompt-hook" }] }
    ]
  }
}
```

Kill-switch: `CORTEX_NO_PROMPT_HOOK=1`.

## Code index

`cortex index` builds `.cortex/code.db` — files, symbols and imports extracted
with tree-sitter. It is fully regenerable (never committed) and incremental:
only files whose size/mtime changed are re-read, and a content hash skips
touch-only changes. MCP sessions reconcile it lazily on the first query that
needs it, catching up on edits made while the server was down.

Only TypeScript/JavaScript (`ts`, `tsx`, `js`, `jsx`, `mts`, `cts`, `mjs`,
`cjs`) is indexed. Files in other languages degrade gracefully: they get no
symbol or import rows, so decisions about them anchor at the file level and
impact analysis walks only decision links, not code imports. Import
resolution is heuristic by design — edges carry a `provenance` column
(`exact` for relative specifiers with explicit extensions, `heuristic` for
everything else) and `cortex doctor` reports the measured resolution rate.

## Development

```bash
bun run test                # storage/search tests run against real SQLite
bun run test:coverage       # coverage report, 100% threshold enforced
RUN_MODEL_TESTS=1 bun test  # also load the real embedding model
bun run check               # Biome lint + format
bun run typecheck
```

`CORTEX_DISABLE_EMBEDDINGS=1` runs any command or the server without the
embedding subprocess (search degrades to FTS).
