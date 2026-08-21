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
- `CORTEX_VERSION=v0.5.0` pins a release; `CORTEX_INSTALL_DIR=/somewhere/bin`
  changes the destination.

Prefer not to pipe a URL into a shell? Download the tarball for your platform
from the [releases page](https://github.com/lucasreali/cortex-cli/releases),
verify it, and move the binary yourself:

`checksums.txt` covers every platform's asset, so verify the one line matching
what you downloaded instead of the whole file:

```bash
asset=cortex-v0.5.0-darwin-arm64.tar.gz

grep " $asset\$" checksums.txt | sha256sum -c -   # shasum -a 256 -c - on macOS
tar -xzf "$asset"
mv cortex ~/.local/bin/
```

The tarball also carries `LICENSE` and `THIRD-PARTY-NOTICES.md`, which name
every package bundled into the binary beside them.

`checksums.txt` is served by the same origin as the download, so on its own it
detects corruption rather than substitution. Every asset is also attested with
Sigstore at build time, which binds the bytes to the workflow, commit and
repository that produced them and is verified independently of GitHub
Releases:

```bash
gh attestation verify "$asset" --repo lucasreali/cortex-cli
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

`init` writes `.gitignore` rules that version the decisions and the config —
which pins the embedding model, so a teammate cannot fill the same store from
a different one — and ignore the derived caches:

```gitignore
/.cortex/*
!/.cortex/config
!/.cortex/decisions/
```

Commit each decision file with the change it explains. To keep decisions
private to your machine instead, drop the two negations.

Then register the MCP server with your agents — once, at user scope; a single
server instance serves every initialized project:

```bash
cortex install          # detects your agents and asks per harness
cortex install --yes    # non-interactive: configure everything detected
```

`install` detects Claude Code (`~/.claude.json`), Codex CLI
(`~/.codex/config.toml`), Cursor (`~/.cursor/mcp.json`) and Gemini CLI
(`~/.gemini/settings.json`), and writes only the `cortex` entry — sibling
servers and the rest of each file are preserved, and a file it cannot parse is
reported and left untouched. `--target claude,cursor` restricts the set
(`auto` and `all` also work); re-runs are idempotent. `init` complements it in
each project by maintaining a marker-fenced usage block in the instruction
files of the harnesses you use — `CLAUDE.md`, `AGENTS.md` (Codex/Cursor) and
`GEMINI.md` — so agents know to consult and record decisions.

Registration is user-wide; git hooks are per repository. In each repo you want
reconciled automatically:

```bash
cortex install --git-hooks              # post-commit, post-checkout, post-merge
cortex install --git-hooks --uninstall  # remove them again
```

See [Automatic reconcile](#automatic-reconcile-git-hooks) for what they do.

Manual registration remains possible; the equivalent entries are:

```jsonc
// ~/.claude.json, ~/.cursor/mcp.json (~/.gemini/settings.json omits "type")
{ "mcpServers": { "cortex": { "type": "stdio", "command": "$HOME/.local/bin/cortex", "args": ["serve", "--mcp"] } } }
```

```toml
# ~/.codex/config.toml
[mcp_servers.cortex]
command = "/home/you/.local/bin/cortex"
args = ["serve", "--mcp"]
```

EmbeddingGemma-300m (~300 MB) is downloaded to `~/.cortex/models/` on first
use. Run `cortex embed --fetch-model` once after `init` to get it over with
instead of paying for it mid-session; it has no deadline, so a slow link only
makes it slow. Until it lands, search answers on full text alone.

## Uninstall

```bash
rm ~/.local/bin/cortex
rm -rf ~/.cortex        # model, grammar cache and daemon state
```

Per-project `.cortex/` directories hold your decisions and are left alone.

## How it works

The agent gets six tools:

| Tool | Purpose |
|---|---|
| `save_decision` | Record a decision: title, rationale, keywords (PT/EN), optional module, file/symbol anchors, `depends_on` links, `replaces`, `archives` (retire a decision that no longer applies, without a successor) and `conflicts_with`; returns `conflict_candidates` — already-recorded decisions close enough to contradict the new one |
| `save_session_summary` | Persist the session's "Implemented / Decisions / Open" narrative — local to the machine, surfaced by `get_context`'s overview |
| `get_context` | Semantic search by intent ("como autenticamos usuários?") or recent active decisions |
| `get_impact` | Everything affected by changing a decision — dependency links walked both ways |
| `search` | Keyword search (accent-insensitive FTS) with optional semantic ranking |
| `search_all_projects` | Search every Cortex project registered on this machine (`~/.cortex/projects.json`, filled by `cortex init` and first use); results grouped per project, never merged — also available as `cortex search --all-projects` |

The registry is a cache and can be deleted, but never silently: if
`projects.json` is ever unreadable, it is kept as
`projects.json.corrupt.<timestamp>` before anything writes over it, and
`cortex doctor` reports both the backup and how many projects are registered.

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

Cortex also keeps track of which decisions a session was shown and which it
actually acted on — it called `get_impact` on them, or linked them from a new
decision. That signal lives in `.cortex/local/`, is never committed, and only
breaks ties: among results your search cannot tell apart by score, the ones
that proved useful on this machine come first. Deleting the directory changes
the order of results, never which results you get, and `cortex doctor` reports
how much of it has accumulated. `CORTEX_NO_USEFULNESS=1` turns the recording
off.

### Query log (off by default)

Cortex can also keep a plain-text record of the questions you ask it — the
`get_context` intents and the `search` terms, with the number of results each
one returned. It is **off by default and stays off unless you turn it on**:
that record contains your queries, which is your content, and it would live in
a file no repository's retention policy covers. Turning it on is a local
decision, and nothing about it is ever sent anywhere or committed.

| Variable | Effect |
| --- | --- |
| `CORTEX_QUERY_LOG=1` | Turns recording on. Anything else, including unset, leaves it off. |
| `CORTEX_QUERY_LOG_PATH=/path/to/queries.jsonl` | Writes the log there instead of `.cortex/local/queries.jsonl`. It says *where*, not *whether* — on its own it records nothing. |
| `CORTEX_NO_QUERY_LOG=1` | Turns recording off, and wins over `CORTEX_QUERY_LOG=1`. |

Each line is one query: the intent or the terms, whether it was an exact
search, the module filter, how many decisions came back and the first ten ids.
Titles, bodies and scores are not recorded, the cross-project sweep
(`search_all_projects`) is not recorded, and the prompts behind passive recall
are never recorded at all.

The file lives in `.cortex/local/`, is never committed, is capped, and can be
deleted at any time. `cortex doctor` reports its state as a fact — off, on and
empty, or "N of your last 50 queries returned nothing" — and names a log left
behind by an earlier opt-in so you can delete it. What it is for: turning real
traffic into evaluation fixtures instead of hand-written ground truth, and
telling you when your searches keep coming back empty.

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

Reconciling is lazy by default — it happens when you run a command. `cortex
install --git-hooks` makes it happen when the branch changes instead; see
[Automatic reconcile](#automatic-reconcile-git-hooks).

`cortex sync` forces the full pass and reports what it found: files that will
not parse, links whose target this store has never seen, and decisions
superseded from two branches at once. A fresh clone has no vectors until
`cortex embed --missing` runs; until then search answers on full text, which
measures 0.978 recall@5 against 1.000 with vectors.

## CLI

```bash
cortex install [--yes] [--target T]     # register the MCP server with detected agents
cortex install --git-hooks              # reconcile on commit, checkout and merge
cortex log [--module M] [--since SHA]   # active decisions, newest first
cortex why <path>                       # decisions anchored to a file or directory
cortex search <terms...> [--exact]      # search with score and origin
cortex impact <id>                      # indented dependency tree
cortex index [--force]                  # (re)build the code index incrementally
cortex sync                             # reconcile the store with this branch's files
cortex embed --missing | --rebuild      # fill or rebuild the vector index
cortex embed --fetch-model              # download the embedding model, no deadline
cortex doctor                           # config, anchors, embeddings, model, code index
cortex benchmark [--write] [--json]     # tokens read per question vs corpus and grep
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

## Automatic reconcile (git hooks)

`cortex install --git-hooks` writes a marker-fenced block into three hooks of
the repository you run it in:

- **post-checkout** — the branch changed, so decisions that live on the branch
  you left drop out of `log`, `why`, `search` and passive recall, and the ones
  you came back to return;
- **post-commit** — a decision committed with the code it explains is in the
  store before you type anything else;
- **post-merge** — a `git pull` that fast-forwards fires neither of the other
  two, and pulling someone else's decisions is the whole point.

The block calls `cortex git-hook`, which reconciles and then, after a commit or
a merge, embeds anything new in the background. It never fails the git command
that ran it, and it never creates a store: a repository with no `.cortex/` is
left exactly as it was.

The hooks directory comes from git itself (`git rev-parse --git-path hooks`),
so `core.hooksPath` and husky are respected and every linked worktree is served
by the same file — each one reconciles its own store. A hook you already own is
kept and the block appended below it; uninstalling removes only the block. A
hook written in another language is refused rather than broken.

The absolute path of this binary is pinned at install time, because git runs
hooks with the minimal `PATH` of GUI clients and CI runners. If that path stops
existing, the hooks quietly do nothing until you rerun the install.

Kill-switch: `CORTEX_NO_GIT_HOOK=1`. The code index is deliberately not rebuilt
here — it stays lazy, and `cortex index` is the explicit pass.

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

## Benchmarks

`cortex benchmark` measures the claim the whole tool rests on: that an agent
reads a few decisions instead of the record, let alone the repository.

```bash
cortex benchmark                # human table
cortex benchmark --json         # the same numbers, plus per-question detail
cortex benchmark --write        # regenerate BENCHMARKS.md at the repo root
cortex benchmark --limit 10     # shorten the question list while iterating
```

It asks one question per active decision — the decision's own title — runs it
through the same `search` path an agent takes, and charges the answer the full
text of every decision file it names. Against that it puts two baselines: the
whole decision corpus, and a naive `grep -il` over every tracked file outside
`.cortex/`, one keyword at a time (their union would only measure the
connectives). On this repository, at 59 active decisions:

| what the agent reads per question | tokens | vs cortex |
| --- | ---: | ---: |
| whole decision corpus (59 decisions) | 24,783 | 11.6x |
| repository grep, median keyword (32.3 files) | 69,999 | 32.9x |
| repository grep, narrowest keyword (3.1 files) | 7,689 | 3.6x |
| cortex answer (5.0 decisions) | 2,128 | 1.0x |

Token counts are a deterministic approximation, named in the output
(`atoms-per-5-bytes/v1`) so they are never mistaken for another model's
tokenizer; both sides of every ratio use the same counter.
[`BENCHMARKS.md`](BENCHMARKS.md) is generated by `--write` and carries the
method, the corpus size and the date. Retrieval *quality* is measured
separately by `bun run eval:search`.

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
bun run benchmark           # regenerate BENCHMARKS.md (needs the model)
```

`CORTEX_DISABLE_EMBEDDINGS=1` runs any command or the server without the
embedding subprocess (search degrades to FTS).

### Releasing

```bash
bun run build               # single-file binary for this platform
bun run smoke:compiled      # drives the binary end to end
bun scripts/package-release.ts   # all 7 targets + checksums into dist/release
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes
`dist/release/*` to GitHub Releases. The tag must match `package.json`'s
version — the workflow fails loudly if it does not, since `CORTEX_VERSION` is
read from `package.json` and travels in the daemon handshake.

Before it publishes anything, the release calls `ci.yml` as a reusable
workflow, so a tag passes the same gate a branch does rather than a subset of
it. It then unpacks the tarball it is about to upload and drives *that* binary
through the compiled smoke test, so the bytes proven to work are the bytes
that ship, and attests their provenance with Sigstore.

A newly installed binary can find a daemon from the previous version still
listening — the socket is keyed by model, not by version. The handshake
rejects the version mismatch and the session falls back to a private worker,
which is why `cortex upgrade` stops the old daemon once the new binary is in
place. Installing over the old binary by hand leaves it running until its idle
timeout; an MCP server already running inside an editor keeps the old binary
until the client restarts it either way.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Lucas Reali.

The released binary is a single file with every dependency bundled into it, so
each tarball ships `LICENSE` and `THIRD-PARTY-NOTICES.md` next to `cortex`.
The notices file is generated from the bundle itself at packaging time, so it
names exactly the packages whose code is inside the binary that carries it.
