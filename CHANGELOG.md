# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`CORTEX_VERSION` is read from `package.json` and travels in the daemon
handshake, so the version here, the version there and the git tag are one fact
in three places — the release workflow refuses a tag that disagrees.

## [0.5.0] - 2026-08-21

The release that follows a full pre-release audit: 123 findings across store
integrity, the indexer, embedding, the release channel, the MCP server and the
CLI surface. Almost none of them were behaviour anyone had asked for — they
were missing guards, missing bounds, and contracts `CLAUDE.md` stated that the
code did not quite keep.

### Added

- **Usefulness ranking.** Which decisions a session was shown and which it
  acted on are appended to a gitignored local log and used as a search
  tiebreaker. Nothing here is versioned and nothing reaches a decision file.
- **Query log**, off by default: one line per `get_context` intent and per
  `search`, in the same local directory. A query holds the text of the
  question, so it is opt-in where usefulness is not.
- **Anchor confidence.** Each anchor is graded by how well it resolves against
  the code index, and degrades to `unknown` rather than guessing.
- **`cortex benchmark`** measures the context economy the project's pitch
  rests on, and writes `BENCHMARKS.md`.
- **Git hooks.** `cortex install` registers `post-commit`, `post-merge` and
  `post-checkout` hooks that reconcile the store against the branch.
- **Declared conflicts** surface in the impact answer.
- `cortex doctor` reports embedding vectors left behind by another model, and
  the shared daemon's lock and socket state.
- `embed-worker` and `embed-daemon` explain themselves when asked.
- A `LICENSE`: the project is MIT, and every release tarball now carries that
  text and `THIRD-PARTY-NOTICES.md` for the twelve packages bundled into the
  binary beside them.
- This changelog, a `SECURITY.md`, and issue templates.

### Changed

- The release workflow calls CI as a reusable workflow instead of restating a
  subset of it, then smoke-tests the bytes it is about to publish rather than
  a second compile of the same source.
- Every release asset is attested with Sigstore, so `checksums.txt` is no
  longer the only root of trust.
- The code index re-checks the working tree on a window instead of answering
  from a startup snapshot, and reads the symbol table once per resolver rather
  than once per anchor.
- `tsconfig.json` `extends` chains are followed when resolving path aliases,
  and `.ts` and `.tsx` are parsed with their own grammars.
- The MCP runtime cache is a bounded, leased LRU with a drained shutdown;
  foreign projects in the cross-project sweep are opened read-only.
- `get_impact` caps its answer and says so instead of implying completeness.

### Fixed

- A duplicated anchor, a malformed file or a `replaces` cycle in
  `.cortex/decisions/` no longer takes the whole store down.
- The three races on a store's first use: the migration runner, the WAL
  switch and the busy handler. A store whose schema is ahead of the binary is
  refused rather than written to.
- Every parsed tree is freed by the indexer, which is what kept `index` from
  peaking near a gigabyte on a mid-sized repository.
- An unreadable, oversized or binary file is a skipped file with a reason, not
  a failed index run.
- The first model download gets a budget it can finish inside; a failed model
  load is no longer memoised for the worker's life; a daemon that drops
  mid-request falls back to the private worker rung instead of straight to
  FTS; the vector cache reloads when another process embedded.
- `install.sh` stages inside the destination directory and proves the binary
  runs before replacing the one already there.
- MCP registration no longer corrupts or reverts an existing agent config, and
  `cortex init` appends only the gitignore rules that would still apply.
- A rebase replays many commits and embeds once, at the last one; a busy store
  defers the reconcile instead of dropping it.
- `--json` is honoured on the error paths, and flags stop at `--`.

### Security

- An installed `cortex` upgrades only from github.com:
  `CORTEX_RELEASE_BASE_URL` no longer turns `cortex upgrade` into "download
  and execute from anywhere".
- A decision file can no longer close the prompt-hook fence and inject
  instructions into every prompt.
- The tar reader bounds what it will believe about a member, the staging file
  is created exclusively, and an abandoned one is reclaimed.
- Anchor paths that escape the repository are rejected.
- An unreadable project registry is backed up before anything rewrites it.

## [0.4.0] - 2026-08-05

### Added

- **Cross-project search** over a persistent project registry:
  `search_all_projects` fans out over `~/.cortex/projects.json` and returns
  results grouped per project, never merged into one ranking.
- **Conflict detection**: `conflicts_with` links, declared one-sided and read
  symmetrically, plus save-time conflict candidates.
- **Archiving**: a decision with no successor is retired by a file carrying
  `archives`.
- **`save_session_summary`**, the MCP tool that persists an
  Implemented / Decisions / Open narrative for the next session.

## [0.3.0] - 2026-08-04

### Added

- **`cortex install`** onboards coding agents: MCP registration plus an
  instruction block written into the agent's own config.

## [0.2.1] - 2026-08-04

### Added

- **Decisions are files.** One immutable markdown file per decision under
  `.cortex/decisions/`, versioned with the code it explains; SQLite becomes a
  derived cache reconciled from the branch.
- **`cortex sync`** reconciles the store against the working tree, and
  `cortex doctor` reports the branch a decision lives on.

### Fixed

- A clone carrying decision files is treated as an initialized project.
- The embedding path degrades to the private worker when the daemon spawn
  fails.

## [0.2.0] - 2026-08-01

### Added

- **`cortex upgrade`**: the binary downloads its own replacement, verifies it
  against the release's `checksums.txt`, runs it once, and only then swaps it
  in.
- CI runs lint, types, coverage and the compiled binary on every commit.

## [0.1.0] - 2026-08-01

First release: decisions in SQLite, a tree-sitter code index over TS/JS,
local semantic search through a WASM embedding worker, the CLI, and an MCP
server.

[0.5.0]: https://github.com/lucasreali/cortex-cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/lucasreali/cortex-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lucasreali/cortex-cli/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/lucasreali/cortex-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lucasreali/cortex-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lucasreali/cortex-cli/releases/tag/v0.1.0
