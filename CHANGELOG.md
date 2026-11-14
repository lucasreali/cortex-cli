# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`CORTEX_VERSION` is read from `package.json` and travels in the daemon
handshake, so the version here, the version there and the git tag are one fact
in three places — the release workflow refuses a tag that disagrees.

## [0.7.0] - 2026-11-14

Integrity, security and the agent's access to the "why". Every item comes
from an audit of 0.6.1: two clones of one repository could answer
differently, the prompt hook trusted any clone, `cortex upgrade` accepted any
fork on github.com, and no tool returned a decision's full rationale.

### Upgrade notes

- **The prompt hook now injects decision text only in trusted projects.**
  `cortex init` trusts the project it initializes; for a project you cloned,
  run `cortex trust` in it once. Elsewhere a match produces a one-line
  pointer to `get_context` and nothing from the decision files.
- **The embedding model downloads once more** (~300 MB). It is now pinned to a
  Hugging Face commit, which moves where it is cached; run
  `cortex embed --fetch-model`. The old copy under
  `~/.cortex/models/onnx-community/embeddinggemma-300m-ONNX/` (outside the new
  revision directory) can be deleted.
- `decisions.db` migrates to schema 6 on first use, and every decision row is
  re-read from its file once.

### Added

- `get_decision` MCP tool: full body, keywords, anchors with confidence and
  the versioned links of decisions by id.
- `cortex trust [--revoke]`.
- `get_impact` labels each entry `dependent` or `dependency`, and
  `code_impacted` includes decisions anchored to the same files (depth 0) and
  to directories containing them.
- `doctor` reports duplicate decisions, notes decisions that link out, carry
  shell commands, address the model or use catch-all keywords, and states
  whether the project is trusted.

### Changed

- Search results from `get_context` and `search` carry a `rank` instead of
  the raw fusion score; anchors omit an empty `symbol`; tool descriptions are
  about a third shorter, and `save_decision`'s says what a decision is.
- Session summaries are stored in `.cortex/local/sessions.jsonl` instead of
  `decisions.db`, which error messages describe as a disposable cache.
  Summaries already in the database are still shown.
- The MCP server re-reconciles decision files every few seconds instead of
  once per process, so a pull mid-session is picked up without git hooks.
- `cortex embed --missing` embeds in batches and continues past a failure,
  reporting what was left without a vector.
- `init` lists the model download, git hooks and prompt hook in its next steps.

### Fixed

- A decision file edited in place is re-read into its row, anchors, FTS
  entry and (when title or body changed) vector; before, it stayed stale
  forever while its links were re-derived.
- A successor that stops parsing no longer hands the decision it replaced
  back to search.
- Anchors to private members (`Foo.#bar`) and anchors written with
  backslashes or `./` resolve on every clone.
- `get_context`'s `module` filter applies before the top 5 are chosen.
- `cortex serve --mcp` exits when its client closes stdin; a killed client
  used to leave the server and a ~1.3 GB worker running.
- A daemon that was unreachable once is retried after a minute instead of
  never again in that process.
- `cortex upgrade` only installs from this repository, requires a
  build-provenance attestation from its release workflow, enforces download
  limits while streaming, and signals the old daemon only after it confirms
  its pid on its socket.
- The git hook no longer downloads the model in the background; concurrent
  workers no longer write the same model cache.
- File names with quotes, backslashes or tabs are indexed.
- Git hooks name the `cortex` on PATH when it is the same binary, so a
  package-manager upgrade no longer breaks them.
- On Windows, the daemon's pipe name includes a per-user secret.

## [0.6.1] - 2026-09-06

No change to the program. `verify-windows`, the job that installs the freshly
published Windows asset and drives it, asserted a clean `cortex doctor` — and a
runner that has never embedded has no model on disk, which doctor reports as a
finding and exits non-zero for, correctly. `verify-darwin` never ran doctor for
that reason; the Windows job should not have either.

v0.6.0's Windows asset is published, attested and installable; this release is
the same program with the post-publish verification fixed, so the pipeline that
carries it is green end to end. The 0.6.0 artifacts are left exactly as they
were: this build is not byte-reproducible, so re-cutting that tag would have
republished different bytes under a version already public.

### Fixed

- `verify-windows` no longer asserts a clean `doctor` on a runner with no
  embedding model. Everything the job exists to prove — `install.ps1`, the
  Sigstore attestation, `--version`, `upgrade --check`, `init`, `index` and the
  three git hooks — is unchanged and still asserted.

## [0.6.0] - 2026-09-05

Windows. The packaging was one more Bun target; everything else in this release
is the part that was not — a socket that has no file, a binary that cannot be
renamed over, a shell that reads a backslash as an escape, and an installer
written against what PowerShell ships with rather than against curl and tar.

### Added

- **Windows support**, x64 and ARM64 (the x64 binary, which Windows on ARM runs
  under emulation). Windows 10 1803 or later.
- **`install.ps1`**, the Windows half of `install.sh`: `Invoke-WebRequest`,
  `Get-FileHash` and the bundled `tar.exe`, same checksum discipline, same
  `CORTEX_VERSION` and `CORTEX_INSTALL_DIR`. It writes the install directory to
  the user `PATH` rather than printing a hint, because Windows has one to write.
- A `windows` job inside the CI gate that drives the compiled binary end to end
  and asserts `install.ps1`'s `Get-Suffix` agrees with `targetForHost` — the
  check that already exists for `install.sh` — and a `verify-windows` release
  job that installs the published asset the way a user would.

### Changed

- **The shared embedding daemon listens on a named pipe on Windows**, where
  there is no socket file to place beside the lock. The pipe namespace is
  machine-wide, so the owner's name is part of the pipe's; the lock and the log
  stay files. Nothing about the degradation ladder changes.
- **`cortex upgrade` replaces the running binary with two renames on Windows**
  rather than one. The loader holds a running image open, so it is renamed away
  first and the pair is undone if the second rename fails. What it retires
  cannot be deleted by the process running it; the next upgrade sweeps it,
  alongside the staging files an interrupted one leaves behind.
- The release tarball for Windows carries `cortex.exe`. `src/release/archive.ts`
  accepts either name: an upgrade unpacks whatever asset it was handed.
- Git hooks accept a drive-letter path spelled with forward slashes — what
  Git for Windows' bundled `sh` reads — and `selfCommand` produces that
  spelling, so the conversion happens where the path is made rather than at
  every place that quotes it.
- Paths derived from `import.meta.url` go through `fileURLToPath`: `.pathname`
  hands back `/C:/repo`, which no `spawn` and no `fs` call will accept.
- **`RUNS_FROM_COMPILED_BINARY` recognizes both roots of Bun's embedded
  filesystem** — `file:///$bunfs/root/` and Windows'
  `file:///B:/%7EBUN/root/`, whose tilde arrives percent-encoded — and is
  derived in one place (`src/support/platform.ts`) instead of two. The check existed
  twice and was wrong in both copies, so a compiled Windows binary read itself
  as a source checkout: it would have honoured `CORTEX_RELEASE_BASE_URL` and
  `CORTEX_EMBED_WORKER_PATH`, which are test seams an installed binary must
  ignore, and it could not have reached its own `embed-worker` or
  `embed-daemon` subcommands at all.

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

[0.7.0]: https://github.com/lucasreali/cortex-cli/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/lucasreali/cortex-cli/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/lucasreali/cortex-cli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/lucasreali/cortex-cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/lucasreali/cortex-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lucasreali/cortex-cli/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/lucasreali/cortex-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lucasreali/cortex-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lucasreali/cortex-cli/releases/tag/v0.1.0
