# Cortex

Persistent decision memory for coding agents. Cortex records the technical
decisions made while you and your agent work on a repository — what was
chosen, why, and which files it governs — and makes them searchable by
meaning, not just by keyword, from any later session.

Decisions live in `.cortex/decisions.db` (SQLite, committed with the repo).
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
cortex embed --missing | --rebuild      # fill or rebuild the vector index
cortex doctor                           # config, anchors, embeddings, model health
```

## Development

```bash
bun test                    # storage/search tests run against real SQLite
RUN_MODEL_TESTS=1 bun test  # also load the real embedding model
bun run check               # Biome lint + format
bun run typecheck
```

`CORTEX_DISABLE_EMBEDDINGS=1` runs any command or the server without the
embedding subprocess (search degrades to FTS).
