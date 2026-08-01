# cortex-cli

Persistent decision memory for coding agents: a Bun CLI plus MCP server that
stores decisions in SQLite and links them to code through a tree-sitter index.
`README.md` documents user-facing behavior; this file is the map for working
on the code.

## Commands

- `bun test` — full suite (real SQLite, CLI covered end-to-end via subprocess)
- `bun run test:coverage` — 100% line/function threshold enforced (`bunfig.toml`)
- `bun run coverage:audit` — fails when a source file is missing from the
  coverage report entirely; reads the `lcov.info` the previous command writes
- `RUN_MODEL_TESTS=1 bun test` — also loads the real embedding model
- `bun run typecheck` / `bun run check` — strict tsc / Biome (writes fixes);
  `bun run lint:ci` is the read-only Biome used by CI
- `bun run build` — compile the single-file binary; `bun run smoke:compiled` verifies it
- `bun src/cli/main.ts <command>` — run the CLI from source

## Architecture

Dependency direction, no cycles:
`cli`/`mcp` → `app` → `embedding`/`indexer`/`storage`/`git` → `domain`

- `domain/` — pure types + Zod schemas; depends only on zod. Shared
  invariants (e.g. `MINIMUM_KEYWORDS`) are defined here, nowhere else.
- `storage/` — thin repositories over `bun:sqlite`. Two databases per
  project, on purpose: `decisions.db` (permanent, the product) and `code.db`
  (disposable, wiped and rebuilt freely) — never merge them. `nodes_fts` is
  insert-only; `SearchRepository` joins `nodes` on `status = 'active'`, so
  replaced decisions never leave the index and consumers do not re-filter.
- `git/` — subprocess git: repo root, HEAD, canonical project identity.
- `indexer/` — tree-sitter code index (TS/JS only), reconciled lazily on
  first use; no file watcher (deliberate — see todo.md).
- `embedding/` — the hard part; see topology below.
- `release/` — self-update: resolve a GitHub release, verify its checksum,
  unpack the ustar member, replace the running binary by atomic rename. It
  imports nothing from the other `src/` directories, on purpose.
- `app/` — use cases; `runtime.ts` is the composition root. Use cases narrow
  `CortexRuntime` with `Pick<>` instead of introducing interfaces.
- `cli/` — hand-rolled dispatch table in `main.ts` (deliberate, no CLI
  framework); one file per command in `cli/commands/`.
- `mcp/` — server with 4 tools; `RuntimeRegistry` caches one runtime per
  resolved project root. Recoverable states return `guidanceResult`, never
  `isError`.

## Embedding process topology

Three processes, reachable as hidden CLI subcommands (`prompt-hook`,
`embed-worker`, `embed-daemon`) so the compiled binary can spawn itself
(`embedding/subprocess-command.ts`):

- CLI commands spawn a private worker subprocess (NDJSON on stdio, WASM
  transformers.js — native addons would break the single-file binary).
- The MCP server prefers the per-user shared daemon (Unix socket), falling
  back to a private worker.
- Degradation ladder — never weaken it: shared daemon → private worker →
  pure FTS. The vector path never blocks a query: every await on it is bounded
  by a timeout, and FTS answers when one fires. The two paths differ on
  purpose: an embed disposes of the worker on timeout (`embedding/queue.ts`,
  `cli/commands/embed-all.ts`, the daemon), while a query leaves it alone
  (`embedding/semantic-search.ts`) so a model still loading after an idle-kill
  finishes for the next query instead of restarting.
- The daemon serves one worker to every session, and the worker embeds one
  request at a time, so the daemon queues rather than pipelines: a request's
  deadline starts when it reaches the worker, never while it waits behind
  another session (`embedding/serial-lane.ts`).

`prompt-hook` bypasses `app/runtime` and opens the database read-only on
purpose: it runs on every prompt and must never fail or migrate state.

## Conventions

- Bun-native APIs throughout (`bun:sqlite`, `Bun.spawn`, `Bun.file`); never
  reach for Node equivalents when Bun has one.
- DDL, migrations and non-trivial queries (recursive CTEs) live in `.sql`
  files loaded with Bun text imports; small repository queries stay inline.
- Comments are a last resort, not a default. Before writing one, judge whether
  the code can carry the meaning itself — extract a named function, constant or
  variable, and the comment becomes unnecessary. Write one only for what code
  cannot express: a non-obvious external constraint (OS semantics, a protocol
  contract, a library quirk, a rejected alternative) or the reasoning behind a
  deliberate trade-off. Never restate what the line below already says. A
  comment that survives that test has earned its place — keep it, and keep it
  accurate.
- Cross-directory imports use the `@/` alias; same-directory stay relative.
  Descending imports (`./commands/x`, `./tools/y`, `./queries/z.sql`) also stay
  relative — the alias rule targets imports that climb out of a directory with
  `../`, and `lint:ci` fails on those.
- Comments and markdown are written in English, `.sql` files included.
- The release asset suffix is baked into each cross-compiled binary through
  `Bun.build`'s `define` (`scripts/compile.ts`), because musl and baseline
  builds are indistinguishable from the inside at runtime. `install.sh`'s
  `detect_suffix` and `release/target.ts` must keep agreeing.
- Coverage counts only files imported in-process: `src/cli` is exercised by
  spawning the CLI from `tests/cli/`, keeping it out of the coverage report.
  A file that never loads in-process is therefore invisible rather than 0%, so
  `scripts/coverage-audit.ts` holds the explicit list of files allowed to be
  absent (subprocess-covered or type-only) and fails on anything else — a new
  untested file cannot slip past the threshold. Both directions are checked:
  an exemption that becomes instrumented or deleted fails too.

## Dogfooding

This repo records its own technical decisions in `.cortex/decisions.db`
(committed; `code.db` is gitignored). After a decision is confirmed, save it
through the real interface — `save_decision` against `cortex serve --mcp` —
then run `cortex embed --missing` and `cortex doctor`.
