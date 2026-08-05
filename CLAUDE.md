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
`cli`/`mcp` → `app` → `embedding`/`indexer`/`storage`/`git` → `domain`/`support`

- `domain/` — pure types + Zod schemas; depends only on zod. Shared
  invariants (e.g. `MINIMUM_KEYWORDS`) are defined here, nowhere else.
- `support/` — dependency-free leaf helpers (`errorMessage`, `errnoCode`,
  `parseJsonOrNull`, `sha256Hex`, `truncate`, `writeAtomically`,
  `userCortexDir`). Anything may import it, including `release/`; it imports
  nothing. Put a helper here only once a third call site wants it.
- `storage/` — thin repositories over `bun:sqlite`. Two databases per
  project, on purpose: `decisions.db` and `code.db` — never merge them. Both
  are derived caches now; the product is `.cortex/decisions/`. `nodes_fts` is
  insert-only; `SearchRepository` joins `nodes` on `status = 'active' AND
  present = 1`, so neither a replaced decision nor one belonging to another
  branch leaves the index, and consumers do not re-filter.
  `DecisionSyncRepository` holds the decision write surface, apart from
  `NodeRepository`, because only the reconciler may use it.
- `decisions/` — the versioned product: one immutable markdown file per
  decision under `.cortex/decisions/`, and the reconciler that derives SQLite
  from them. Peer of `indexer/`, same shape: read the working tree, fill a
  derived store, share types through `domain/`. Everything here is
  synchronous — the reconcile runs in one `bun:sqlite` transaction, which
  cannot survive an `await`.
- `git/` — subprocess git: repo root, HEAD, canonical project identity.
- `indexer/` — tree-sitter code index (TS/JS only), reconciled lazily on
  first use; no file watcher (deliberate — see todo.md).
- `embedding/` — the hard part; see topology below.
- `release/` — self-update: resolve a GitHub release, verify its checksum,
  unpack the ustar member, replace the running binary by atomic rename. It
  imports nothing from the other `src/` directories except `support/`, on
  purpose: the upgrade path must not drag the store or the model in behind it.
- `app/` — use cases; `runtime.ts` is the composition root. Use cases narrow
  `CortexRuntime` with `Pick<>` instead of introducing interfaces.
- `cli/` — hand-rolled dispatch table in `main.ts` (deliberate, no CLI
  framework); one file per command in `cli/commands/`.
- `mcp/` — server with 5 tools; `RuntimeRegistry` caches one runtime per
  resolved project root. Recoverable states return `guidanceResult`, never
  `isError`.

## Decisions are files, the database is a cache

**A decision file is immutable. Changing your mind writes a new file with
`replaces`; nothing ever rewrites an existing one.** This is what lets drift
detection be a plain set difference, lets `nodes_fts` stay insert-only, and
lets a stored vector outlive a branch switch without a content hash. If an
edit path is ever added, stored vectors and FTS rows go stale silently —
revisit a `content_sha` column that day, and not before.

- `nodes.present` is a working-tree fact (is the file on this branch?),
  `status` a product fact (was it superseded?). Orthogonal, never folded.
- Nothing is deleted, ever. Switching branches flips `present`; a decision
  that comes back keeps its embedding and its row.
- Versioned in the file: the decision, its anchors, `DEPENDS_ON`,
  `REPLACED_BY`, `ARCHIVED_BY` (a file with `archives` retires a decision
  that has no successor), `CONFLICTS_WITH` (declared one-sided via
  `conflicts_with`, read symmetrically). Status is derived from `replaces`
  and `archives`, with `replaced` winning when both name the same decision.
  Local to the machine: session and project nodes,
  `BELONGS_TO`, `GENERATED_IN`, embeddings, `nodes_fts`. A decision imported
  from someone else's branch has no `GENERATED_IN` — that session never
  happened here, and that is correct.
- Edge targets are validated against the store, not the branch. A dangling
  target is skipped and reported; inserting it would fail every command,
  because foreign keys are on.
- `save_decision` writes the file, inserts the row, then reconciles. Status
  and versioned edges are derived in exactly one place, so a decision saved
  here goes through the same path as one that arrived from a pull.
- The reconcile does not enqueue embeddings: a pull must not make `cortex log`
  load the model, and a CLI process disposes before the embed would finish.
  `cortex embed --missing` owns that, and doctor reports the pending count.
- `prompt-hook` never reconciles — it is read-only and must never migrate. It
  serves the previous view until the next command runs.

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
  builds are indistinguishable from the inside at runtime. `release/target.ts`
  is only the fallback for a locally built binary. `RELEASE_SUFFIXES` there is
  the one list — `scripts/package-release.ts` compiles from it and
  `targetForHost` selects from it — and CI runs `install.sh`'s `detect_suffix`
  against `targetForHost` on the runner, so the two cannot drift silently.
- Coverage counts only files imported in-process: `src/cli` is exercised by
  spawning the CLI from `tests/cli/`, keeping it out of the coverage report.
  A file that never loads in-process is therefore invisible rather than 0%, so
  `scripts/coverage-audit.ts` holds the explicit list of files allowed to be
  absent (subprocess-covered or type-only) and fails on anything else — a new
  untested file cannot slip past the threshold. Both directions are checked:
  an exemption that becomes instrumented or deleted fails too.

## Dogfooding

This repo records its own technical decisions in `.cortex/decisions/`
(committed; the two `.db` files are gitignored and rebuilt on demand). After a
decision is confirmed, save it through the real interface — `save_decision`
against `cortex serve --mcp` — then run `cortex embed --missing` and
`cortex doctor`, and commit the new markdown file with the change it explains.

`tests/evaluation/ground-truth.test.ts` reads those files and asserts every
id it cites is still an active decision here, so deleting or superseding one
breaks the suite on purpose.

<!-- cortex:begin -->
## Cortex — decision memory

This project records its technical decisions with cortex (MCP server
`cortex`, tools: `save_decision`, `save_session_summary`,
`get_context`, `get_impact`, `search`).

- Before proposing an approach or changing existing behavior, call
  `get_context` with your intent (or `search` with keywords) — a past
  decision may already govern this code.
- Before reworking code a decision anchors, call `get_impact` with the
  decision id to see everything the change touches.
- When the user confirms a non-obvious decision, save it with
  `save_decision`.
- When the session ends (or a milestone lands), persist an
  "Implemented / Decisions / Open" narrative with `save_session_summary`
  — the "Open" section is how the next session recovers unfinished work.
- Decision files live in `.cortex/decisions/` and are committed with the
  code they explain.
- If semantic search returns nothing useful, embeddings may be missing —
  suggest running `cortex embed --missing`.

More: https://github.com/lucasreali/cortex-cli#how-it-works
<!-- cortex:end -->
