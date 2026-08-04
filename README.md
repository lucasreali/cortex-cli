# Cortex

Persistent decision memory for coding agents. Cortex records the technical
decisions made while you and your agent work on a repository — what was
chosen, why, and which files it governs — and makes them searchable by
meaning, not just by keyword, from any later session.

Each decision is one markdown file under `.cortex/decisions/`, versioned with
your code: it merges between branches, reviews as a diff, and arrives with the
pull. SQLite is the search index built from those files, and stays local.
Semantic search runs fully local: EmbeddingGemma-300m quantized, via WASM in
a dedicated subprocess — no native dependencies, no runtime network calls
beyond the one-time model download to `~/.cortex/models/`.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/lucasreali/cortex-cli/main/install.sh | sh
```

A self-contained binary lands in `~/.local/bin/cortex` — no Bun, no Node, no
`node_modules`. The installer never uses `sudo`, and prints the line to add to
your shell rc if the directory is not already on `PATH`.

- macOS and Linux, x64 and arm64 (glibc and musl). Windows is not supported yet.
- git is the only runtime dependency (project identity and head tracking).
- `CORTEX_VERSION=v0.1.0` pins a release; `CORTEX_INSTALL_DIR=/somewhere/bin`
  changes the destination.

Prefer not to pipe a URL into a shell? Download the tarball for your platform
from the [releases page](https://github.com/lucasreali/cortex-cli/releases),
verify it, and move the binary yourself:

`checksums.txt` covers every platform's asset, so verify the one line matching
what you downloaded instead of the whole file:

```bash
asset=cortex-v0.1.0-darwin-arm64.tar.gz

grep " $asset\$" checksums.txt | sha256sum -c -   # shasum -a 256 -c - on macOS
tar -xzf "$asset"
mv cortex ~/.local/bin/
```

Builds are unsigned. Fetching through the installer is unaffected, but a
tarball downloaded in a browser is quarantined by Gatekeeper — clear it with
`xattr -d com.apple.quarantine ~/.local/bin/cortex`.

## Upgrade

```bash
cortex upgrade           # replace this binary with the latest release
cortex upgrade --check   # report only; --json for a machine-readable answer
```

The binary downloads its own replacement, verifies it against the release's
`checksums.txt`, runs it once to confirm it works on this machine, and only
then swaps it in — an interrupted or corrupt download leaves the binary you
already have untouched.

- `--version 0.1.0` installs a specific release, downgrade included.
- `--force` reinstalls the version you are already on.
- An installed binary upgrades to the same platform variant it was built as.
  To move between variants (glibc to musl, baseline to plain), re-run
  `install.sh`, which re-detects.
- If cortex lives in a directory you do not own, the upgrade stops and says
  so; re-run `install.sh` with `CORTEX_INSTALL_DIR` set to a directory you do.
- Upgrading stops the shared embedding daemon so the next session starts one
  on the new version. An MCP server already running in your editor keeps the
  old binary until its client restarts it.

## Setup

```bash
cd your-project
cortex init     # creates .cortex/, runs migrations, writes config
```

`init` writes a `.gitignore` rule that versions `.cortex/decisions/` and
ignores everything else under `.cortex/`:

```gitignore
/.cortex/*
!/.cortex/decisions/
```

Commit each decision file with the change it explains. To keep decisions
private to your machine instead, drop the second line.

Then register the MCP server with your agent — once, at user scope; a single
server instance serves every initialized project:

```bash
claude mcp add --scope user cortex -- "$HOME/.local/bin/cortex" serve --mcp
```

The first embedding downloads EmbeddingGemma-300m (~hundreds of MB) to
`~/.cortex/models/`. Run `cortex embed --missing` once after `init` to get it
over with instead of paying for it mid-session.

## Uninstall

```bash
rm ~/.local/bin/cortex
rm -rf ~/.cortex        # model, grammar cache and daemon state
```

Per-project `.cortex/` directories hold your decisions and are left alone.

## How it works

The agent gets four tools:

| Tool | Purpose |
|---|---|
| `save_decision` | Record a decision: title, rationale, keywords (PT/EN), optional module, file/symbol anchors, `depends_on` links and `replaces` |
| `get_context` | Semantic search by intent ("como autenticamos usuários?") or recent active decisions |
| `get_impact` | Everything affected by changing a decision — dependency links walked both ways |
| `search` | Keyword search (accent-insensitive FTS) with optional semantic ranking |

Every tool accepts an optional `projectPath` (any directory inside the target
project): the nearest `.cortex/` store is resolved walking up on each call and
its runtime is cached per resolved root, so one server answers for as many
repositories as the session touches. Without it, tools hit the project the
server started in; if the server started outside any initialized project, the
schema makes `projectPath` required. Paths without a store return guidance
(`cortex init`) instead of an error.

Saving writes the markdown file first, then the row that mirrors it. Embeddings
happen asynchronously off the save path and degrade to full-text search
whenever the model is unavailable.

### Decisions and branches

A decision file is immutable: changing your mind writes a new file that
`replaces` the old one, so two branches never edit the same lines and git
merges them without a conflict.

Every command reconciles the store against the files on the branch you have
checked out. A decision whose file is not here is flagged, never deleted — it
drops out of `log`, `why`, `search` and passive recall, and comes back
untouched, embedding included, when you switch back. So a decision from a
branch that never merged stops being a ghost: `cortex doctor` names it as
living on another branch.

Deleting `.cortex/decisions.db` costs nothing you cannot rebuild — the next
command reconstructs every decision, anchor and link from the files. Session
history is the exception: it is local and does not come back.

`cortex sync` forces the full pass and reports what it found: files that will
not parse, links whose target this store has never seen, and decisions
superseded from two branches at once. A fresh clone has no vectors until
`cortex embed --missing` runs; until then search answers on full text, which
measures 0.978 recall@5 against 1.000 with vectors.

## CLI

```bash
cortex log [--module M] [--since SHA]   # active decisions, newest first
cortex why <path>                       # decisions anchored to a file or directory
cortex search <terms...> [--exact]      # search with score and origin
cortex impact <id>                      # indented dependency tree
cortex index [--force]                  # (re)build the code index incrementally
cortex sync                             # reconcile the store with this branch's files
cortex embed --missing | --rebuild      # fill or rebuild the vector index
cortex doctor                           # config, anchors, embeddings, model, code index
cortex upgrade [--check]                # replace this binary with the latest release
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

Working on cortex itself needs [Bun](https://bun.com) 1.3+:

```bash
bun install
bun link                    # exposes `cortex` from source

bun run test                # storage/search tests run against real SQLite
bun run test:coverage       # coverage report, 100% threshold enforced
RUN_MODEL_TESTS=1 bun test  # also load the real embedding model
bun run check               # Biome lint + format
bun run typecheck
```

`CORTEX_DISABLE_EMBEDDINGS=1` runs any command or the server without the
embedding subprocess (search degrades to FTS).

### Releasing

```bash
bun run build               # single-file binary for this platform
bun run smoke:compiled      # drives the binary end to end
bun scripts/package-release.ts   # all 7 targets + checksums into dist/release
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which re-runs the gate
above and publishes `dist/release/*` to GitHub Releases. The tag must match
`package.json`'s version — the workflow fails loudly if it does not, since
`CORTEX_VERSION` is read from `package.json` and travels in the daemon
handshake.

A newly installed binary can find a daemon from the previous version still
listening — the socket is keyed by model, not by version. The handshake
rejects the version mismatch and the session falls back to a private worker,
which is why `cortex upgrade` stops the old daemon once the new binary is in
place. Installing over the old binary by hand leaves it running until its idle
timeout; an MCP server already running inside an editor keeps the old binary
until the client restarts it either way.
