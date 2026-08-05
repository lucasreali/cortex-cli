# Recovered from the prototype (`cortex-mcp`)

Comparative analysis (2026-08-04) between the first prototype
(`../cortex-mcp`: Neo4j + Cohere, HTTP MCP server) and this project. Most of
the prototype survived here in better form — hybrid RRF search, the eval
harness, doctor/integrity, `embed --missing`, `init`/`install`, multi-project
serving. What follows is what got **lost** in the rewrite and is still worth
bringing into this version, ordered by relevance.

---

## 1. Session summaries — the write path never made it over

**Status:** ✅ implemented (2026-08-05) — `save_session_summary` MCP tool
writes the session node's `body` (overwrite semantics, local-only, kept out
of FTS/embeddings on purpose); surfaced by `get_context`'s overview.

**What it was.** The prototype had an `update_session_summary` tool: at the
end of each session the agent persisted a structured narrative
("Implemented / Decisions / Open"). Its frozen backlog had already identified
the gold in it: the **"Open" item is the system's only source of unfinished
work** — and had planned the next step, embedding summaries so `get_context`
could match them by intent instead of only showing the 10 most recent.

**Why it matters here.** This version already carries the dead half of the
feature: sessions are created (`node-repository.ts` `createSession`) and
`get_context` returns `sessions: listSessionSummaries(...)` — but **no code
path ever writes a session's `body`**, and `listSessionSummaries` filters
`body IS NOT NULL AND body != ''`, so the field is always empty. The
infrastructure sits waiting for the tool that was lost in the migration.

**How it lands here.** A `save_session_summary` MCP tool (or an extension of
the session node write path) filling `body` on the local session node.
Sessions are already machine-local by design ("session history is the
exception: it is local and does not come back"), so nothing changes in the
file-based product — this is purely a local-cache feature. Follow-up once it
exists: include summaries in the FTS/semantic index so "what was left open?"
becomes answerable.

## 2. Conflict detection — the hybrid suggest → confirm → surface mechanism

**Status:** ✅ implemented (2026-08-05) — `save_decision` returns
`conflict_candidates` (same-module keyword-overlap + FTS, no embeddings on
the save path); confirmation is the versioned `conflicts_with` frontmatter
field, derived by the reconciler into a directed `CONFLICTS_WITH` edge read
symmetrically; `get_context` enriches both partners with `conflicts_with[]`.

**What it was.** Three coordinated pieces: (1) `save_decision` returned
`conflict_candidates` — semantically close decisions in the same module
(cosine ≥ 0.85), reusing the embedding it had just computed, suggestion only;
(2) a `mark_conflict` tool where the agent confirmed a genuine contradiction,
materializing a symmetric `CONFLICTS_WITH` edge (validated, idempotent);
(3) `get_context` enriched every returned decision with `conflicts_with[]`.
The design respected the product thesis: the heuristic suggests, the agent
confirms, the edge only exists validated.

**Why it matters here.** Completely absent from this version — and it guards
against the failure mode the prototype classified as *silent corruption of
institutional memory*: two contradictory decisions both active, or a
near-duplicate saved instead of a `replaces`. As the store grows past what
one person remembers, nothing today tells an agent that the decision it just
saved contradicts an older one.

**How it lands here.** The exact embedding trick does not map — embeddings
are async off the save path by design. But a same-module FTS/keyword-overlap
check at save time fits the degradation ladder philosophy (FTS answers when
vectors are absent), and `save_decision` can return `conflict_candidates` in
its result payload. Confirmation becomes a `conflicts_with` field on the
decision file (versioned, like `depends_on` / `replaces`), derived into an
edge by the reconciler — so a conflict marked here arrives with the pull,
which the prototype's local-only edge could never do.

## 3. `archive_decision` — retiring without replacing

**Status:** ✅ implemented (2026-08-05) — an `archives: <id>` frontmatter
field on a new decision file, derived into an inverted `ARCHIVED_BY` edge and
an `'archived'` status (migration 005 rebuilt the CHECKs); `replaced` wins
when both retirements name the same decision.

**What it was.** A frozen backlog item born from a strong argument: when the
prototype rejected recency decay in scoring, it concluded that obsolete
decisions saturating the top-N is a **base-hygiene problem**, and the correct
fix is archiving plus `replace` discipline — never temporal decay. But
`replaces` requires a successor decision; there was (and is) no way to say
"this no longer applies" when a module was deleted or an external constraint
disappeared.

**Why it matters here.** The same hole exists: `status` only moves via
`replaces`. A decision about deleted code stays active forever, polluting
search and passive recall, with no honest way to retire it.

**How it lands here.** The immutable-file model accommodates it naturally: a
new file with an `archives: <id>` field, going through the same reconciler
path as `replaces` but without pretending there is a successor. Nothing is
ever edited or deleted, so FTS stays insert-only and stored vectors stay
valid — the invariants this repo's CLAUDE.md marks as load-bearing.

## 4. Explicit cross-project search (opt-in)

**Status:** ✅ implemented (2026-08-05) — `search_all_projects` MCP tool and
`cortex search --all-projects`, fanning out over a persistent
`~/.cortex/projects.json` registry (filled by `cortex init` and first use,
pruned on read); results grouped and labeled per project, never merged, and
never folded into the scoped tools.

**What it was.** Frozen backlog: "how did I solve rate limiting in my other
projects?" — as a deliberately separate, clearly labeled tool, never mixed
into the scoped `get_context`. The separation was a lesson learned the hard
way: cross-project leakage in `list_decisions` had been a real bug there.

**Why it matters here.** This version is in a *better* position than the
prototype ever was: `RuntimeRegistry` already caches runtimes for multiple
resolved roots in a single server, so the plumbing for "every project this
session touched" exists today.

**How it lands here.** A separate `search_all_projects` MCP tool (or
`cortex search --all-projects`) fanning out over the registry's known roots,
each result labeled with its project. Keep the prototype's rule: never fold
this into the scoped tools — scoped reads stay scoped.

## 5. The "Discarded Decisions" guardrails — cheapest item on this list

**What it was.** The prototype's todo.md kept rejected paths *with their
reasoning*, "so the discussion is not reopened without a new argument":

- **Server-side transcript summarizer** — a cold LLM has no project context,
  costs extra, and produces worse output than the agent that was there;
  extraction is the agent's responsibility.
- **Recency decay in scoring** — an active decision is binding regardless of
  age; decay buries foundational decisions exactly when they are most
  authoritative (see item 3 for the correct fix).
- **Retrieval telemetry** (`times_retrieved`) — caching biases the count,
  it turns every read into a write, and it measures the ranker, not
  usefulness.
- **Prompt-driven end-of-session auto-review** — redundant with the
  save-per-task discipline, and performed by the same agent whose judgment
  already skipped the save.

**Why it matters here.** Several apply verbatim to this version (a transcript
summarizer and recency boost are natural-looking "improvements" an agent or a
future session might propose) and none are recorded anywhere in this repo.

**How it lands here.** Not a code change: save each still-applicable rejection
as a decision in this repo's own `.cortex/decisions/` via `save_decision` —
literally the product's use case, and dogfooding is already active.

## 6. Degradation-at-scale measurement

**What it was.** `scripts/degradation/` measured how retrieval precision
**degrades as decision volume grows** (10/50/100/200 decisions), fitting a
logarithmic regression to estimate the critical point (precision < 0.75). It
produced the prototype's only published quality number and settled the
rerank A/B with data.

**Why it matters here.** `tests/evaluation/` answers a different question:
recall/MRR over 46 questions *at the current volume*. It cannot say **when**
the current ranking will stop being good enough. As dogfooding and adoption
grow the store, that curve is the early-warning signal for revisiting search.

**How it lands here.** A synthetic-volume harness in `tests/evaluation/`
(generated decisions at 100/500/1000 on top of the ground-truth set),
reporting recall@5 per volume tier. Local embeddings make this free to run,
where the prototype paid Cohere per experiment.

---

## Minor losses, recorded only

- **`alternatives_rejected[]` as a structured field** became prose inside
  `body` (whose description does ask for "what was rejected"). Acceptable
  simplification — but the prototype embedded that field as a separate search
  signal, and "what was rejected" is often exactly what gets searched.
- **Rerank / pool widening** — lost on purpose, and correctly: this version's
  eval showed RRF fusion at 1.000 recall@5; a paid cross-encoder has nothing
  left to rescue.
