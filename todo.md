# cortex-cli — improvement backlog

Source: comparative review against the sibling project `graphify`
(`../graphify`, Python, ~42k lines) on 2026-08-14. graphify solves a different
problem — a derived code graph, not versioned decision memory — but it has
already hit several operational problems cortex either has open or will reach.

Ordered by leverage. Each item states what to build, why it matters here, and
where the reference implementation lives in graphify.

---

## Medium priority — all shipped 2026-08-15

### 6. Anchor confidence labels — done

Shipped: `src/app/anchor-confidence.ts` grades every anchor `exact` /
`name_only` / `file_only` / `unresolved` / `unknown` against the local index
and the working tree, surfaced in `get_context`, `get_impact`, `cortex why`
and `cortex impact`. Computed on read, stored nowhere and no migration — the
confidence is a property of the resolution, and writing it into `decisions.db`
would give one derived cache a stale copy of another.

graphify labels every edge `EXTRACTED` (explicit in the source), `INFERRED`
(a reasonable deduction, e.g. a call-graph second pass) or `AMBIGUOUS`
(uncertain, listed in the report for human review) — see `ARCHITECTURE.md`,
"Confidence labels".

cortex anchors have the same implicit gradation: an exact symbol match is not
the same fact as a name-only resolution. `doctor` already checks the aggregate
against `MINIMUM_RESOLUTION_RATE = 0.85` (`src/cli/commands/doctor.ts:22`),
but `get_context` hands strong and weak anchors to the agent with equal
weight, so it has no way to discount the weak ones.

- Store the resolution kind on the anchor and surface it in `get_impact` and
  `get_context` output.
- Watch the interaction with the immutability rule: this is a property of the
  *resolution*, which is derived, not of the decision file.

### 7. Opt-in query log — done

Shipped: `src/querylog/`, default off, `CORTEX_QUERY_LOG=1` enables,
`CORTEX_QUERY_LOG_PATH` relocates, `CORTEX_NO_QUERY_LOG=1` disables and wins.
`doctor` reports the state as a fact, `observedQueries` turns real traffic into
candidate evaluation cases. Not recorded: `search_all_projects`, and the prompt
behind `prompt-hook` — logging every prompt would make it a keylogger.

`graphify/querylog.py` is 90 lines: append-only JSONL, fail-silent (never
raises), and **off by default** — with the reasoning written down, that a
default-on record of proprietary queries in `~/.cache`, outside any repo's
`.gitignore` or retention policy, contradicts the project's on-device posture.
Three env vars: an explicit path, an enable flag, and a disable flag that wins
for backwards compatibility.

For cortex this would turn real `get_context` / `search` traffic into
evaluation fixtures for `tests/evaluation/`, instead of hand-written ground
truth, and would let `doctor` report "30% of your last 50 searches returned
nothing".

- Copy the privacy posture verbatim: default off, documented, disable wins.
- Must never raise and never slow down the query path.

### 8. `cortex benchmark` and a BENCHMARKS.md — done

Shipped: `src/benchmark/` plus `cortex benchmark [--limit N] [--write]
[--json]`, and a generated `BENCHMARKS.md`. Token counting is a named,
deterministic approximation (no tokenizer for the model that reads these
decisions exists in process), calibrated to 1.03x a real SentencePiece count.
The `_safe()` check came back negative and is recorded as a known difference:
Bun has no encoder between a JS string and the fd, so a cp1252 console cannot
raise the way CPython does.

`graphify/benchmark.py` measures tokens for the whole corpus against tokens
for the query's subgraph, over a fixed list of sample questions, and the repo
ships the result as `BENCHMARKS.md`.

cortex's pitch is the same economy — the agent reads three decisions instead
of grepping the repo — and it is currently measured nowhere. The evaluation
harness in `tests/evaluation/` already has the retrieval half; this is the
context-size half.

Note graphify's `_safe()` helper there: it degrades box-drawing and arrow
glyphs to ASCII when stdout cannot encode them, because Windows consoles
default to cp1252 and raise `UnicodeEncodeError` mid-output. `src/cli/style.ts`
should be checked against the same failure.

### 9. Single source of truth for symbol-ID normalization — done

Shipped: `src/support/symbol-key.ts`, with idempotence and output-character
-class pinned as properties. The Turkish bug reproduced verbatim in JS —
sweeping every code point, `U+0130` is the only one that breaks idempotence
under the wrong step order. `EXTRACTION_VERSION` went to 2 so a stale `code.db`
is re-extracted. One comparison site is still raw — see item 14.

`graphify/ids.py` exists because three independent producers generate node IDs
— the AST extractor, the LLM subagents, and the builder reconciling edge
endpoints — and they diverged, splitting one entity into disconnected ghost
nodes. The module holds the recipe once, documents *why* each step is in that
order, and guarantees two properties by test: idempotence, and output
containing only `\w` and `_`. The bug that motivated the last fix: casefolding
`İ` expands it into a letter plus a combining mark, so filtering non-word
characters *before* casefold left the function non-idempotent, and the builder
disagreed with the extractor for every Turkish identifier.

cortex has the same three-producer shape: symbols come from tree-sitter,
decision anchors are written by an LLM through `save_decision`, and the
resolver reconciles them. A shared normalizer with an idempotence property
test prevents the whole class.

---

## Low priority / watch

### 10. Corrupt cache entry is not a cache miss

`graphify/cache.py` counts entries that fail to parse (`_corrupt_cache_entries`)
and emits **one** aggregate warning, because a corrupt entry treated as a miss
fails on every future run — silently re-extracting (and, there, re-billing)
the same file forever.

The cortex analogue is a decision markdown file that fails to parse during
reconcile. Confirm whether it is reported or skipped silently, and if silent,
add it to `doctor` as a count rather than a per-file log.

### 11. Atomic write: symlinks and file mode

`graphify/paths.py:_atomic_replace` resolves symlinks before writing, so the
write goes *through* the link to its target instead of replacing the link with
a regular file (keeping worktree and shared-output setups working), and it
copies the destination's existing mode onto the temp file so an atomic replace
never silently tightens a group-readable output to owner-only.

`src/support/atomic-write.ts` does neither. Marginal for decision files inside
a repo — recorded as a known difference, not as a bug.

### 12. Generated agent-facing docs with a CI drift check

`tools/skillgen/` renders 16 per-host skill files from shared fragments plus a
`platforms.toml` manifest, and CI runs `--check` to fail when someone
hand-edits a generated file or forgets to regenerate. It also runs coverage,
schema-singleton and round-trip validators as separate fast jobs.

This is over-engineering for cortex today: `install` registers one MCP server
per target, it does not emit per-host prose. But if it ever writes blocks into
`CLAUDE.md` / `AGENTS.md` per target, the marker + generator + CI-check pattern
is the right shape, and it composes with the markers `cortex install
--git-hooks` already writes into git hooks.

### 13. `post-rewrite` as a fourth git hook

`cortex install --git-hooks` installs `post-commit`, `post-checkout` and
`post-merge`. A rebase or an `--amend` fires `post-rewrite` — but a rebase also
fires `post-checkout` once per replayed commit, which already reconciles, so
the only real gap is an amend that rewrites a decision file without changing
the branch. Deliberately deferred: the next command catches it, and reconcile
is idempotent, so a fourth hook buys little for the surface it adds.

### 14. The fourth symbol comparison site

Item 9 put one normalizer behind the extractor, the anchors an LLM writes and
the matching side — but `NodeRepository.listByFileAnchorOrSymbol` still
compares two anchor symbols with `a.symbol = ?` inside `decisions.db`, where no
normalized key is stored. It is the one producer the shared recipe does not
reach, so the class of bug item 9 closed is still open on that path.

Closing it means either a `symbol_key` column on `anchors` (a `decisions.db`
migration — the `006-` slot is free, item 6 did not need it) or a read-time
comparison in TypeScript. The column is the tempting one and probably the wrong
one: it would be a second copy of the recipe, able to go stale against it, and
`anchors` is small enough that comparing in TypeScript costs nothing.

---

## Explicitly not adopting

- **Module size.** `graphify/extract.py` is 6,719 lines and `cli.py` is 4,224.
  The 25+ language extractors explain part of it, but the organization did not
  keep up — the repo ships an `extractors/MIGRATION.md` acknowledging it. This
  is the opposite of the standards in `CLAUDE.md`.
- **Issue-number comments.** graphify comments carry dense issue references
  (`#2614`, `#1939`). Most of them document *why an alternative was rejected*,
  which is exactly the criterion for a legitimate comment here — but that
  knowledge is what `.cortex/decisions/` stores in this repo, which is an
  argument for cortex's design rather than a reason to copy the practice.
