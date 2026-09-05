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
- `bun run benchmark` — regenerate `BENCHMARKS.md` from the real corpus
  (`cortex benchmark --write`); needs the embedding model, ~25s here
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
  `parseJsonOrNull`, `sha256Hex`, `symbolKey`, `truncate`, `fenceSafe`,
  `withTimeout`, `writeAtomically`, `userCortexDir`, `RUNS_ON_WINDOWS`).
  Anything may import it,
  including
  `release/`; it imports nothing. Put a helper here only once a third call site wants it — `symbolKey`
  arrived with exactly three. `prompt-fence.ts` is the exception that earned its
  place on two: `prompt-hook` renders the fence and the reconcile reports it,
  and neither directory may import the other, so one truth about the tag has
  nowhere else to live. `writeAtomically` and its sync twin resolve the
  leaf symlink chain before choosing the staging path, so a managed path that
  is a link is written *through* rather than replaced, and the staging file
  stays on the target's filesystem — which is the only place rename is atomic.
  They also copy the destination's permission bits onto the staging file, so a
  replace never silently tightens a widened file back to the umask default.
- `storage/` — thin repositories over `bun:sqlite`. Two databases per
  project, on purpose: `decisions.db` and `code.db` — never merge them. Both
  are derived caches now; the product is `.cortex/decisions/`. `nodes_fts` is
  insert-only; `SearchRepository` joins `nodes` on `status = 'active' AND
  present = 1`, so neither a replaced decision nor one belonging to another
  branch leaves the index, and consumers do not re-filter.
  `DecisionSyncRepository` holds the decision write surface, apart from
  `NodeRepository`, because only the reconciler may use it. Concurrency is a
  first-use problem here, not a load problem: on a fresh clone the MCP server, a
  CLI invocation and the post-commit hook all reach the store at once. So
  `busy_timeout` is set before anything that could need a lock, the one switch
  SQLite refuses to run a busy handler for — turning the file to WAL — is
  retried rather than trusted to it, and every migration takes the write lock up
  front and re-checks `_migrations` inside it, so the loser waits and correctly
  does nothing. A store whose `_migrations` is ahead of this binary is refused
  outright: migrations so far only widen a CHECK, so an older binary writing to
  a newer schema is silent damage, not a loud one.
- `decisions/` — the versioned product: one immutable markdown file per
  decision under `.cortex/decisions/`, and the reconciler that derives SQLite
  from them. Peer of `indexer/`, same shape: read the working tree, fill a
  derived store, share types through `domain/`. Everything here is
  synchronous — the reconcile runs in one `bun:sqlite` transaction, which
  cannot survive an `await`.
- `usefulness/` — the local signal behind the search tiebreaker: which
  decisions a session was shown and which it acted on, appended to a
  gitignored JSONL (`usefulness.jsonl`, under `LOCAL_DIRECTORY`). The mirror
  image of `decisions/`: same shape, opposite status — nothing here is
  versioned, nothing here may ever reach a markdown file, and deleting the
  directory costs only an ordering. `usefulnessScores` is pure and takes
  `now`, so one log always yields one map.
- `querylog/` — the opt-in record of what was asked here: one JSONL line per
  `get_context` intent and per `search`, in the same gitignored
  `LOCAL_DIRECTORY` as the usefulness log. Same mechanics as `usefulness/`,
  opposite default, and the reason is the content: usefulness holds ids this
  store already versions, a query holds the text of the question. `QueryLog`
  never throws and never reads on the write path; `observedQueries` turns the
  log into candidate evaluation cases.
- `benchmark/` — the context-economy measurement behind `BENCHMARKS.md`, and
  the third pure peer of `decisions/` and `usefulness/`: it depends on nothing
  but itself and takes the retrieval path as a parameter, so it is the one
  directory here that can be reasoned about without a store. `TokenCount` is an
  approximation on purpose — no tokenizer for the model that will read these
  decisions exists in process — so `TOKEN_METHOD` names the rule in every
  output, and both sides of every ratio use the same counter.
- `git/` — subprocess git: repo root, HEAD, canonical project identity, hooks
  path. Every accessor answers `null` outside a repo; none of them throw —
  which is a claim about `Bun.spawnSync` too, not only about exit codes: no
  `git` on PATH and a cwd that no longer exists both raise rather than fail,
  and they are exactly the cases the callers' fallbacks were written for.
  `src/git/replay.ts` is the one file here that reads the git directory instead
  of spawning git: a hook must not trust the GIT_DIR it inherits (git names the
  superproject during submodule work), and a replay is a fact on disk anyway.
- `indexer/` — tree-sitter code index (TS/JS only), reconciled lazily on
  first use; no file watcher (deliberate). What replaces the watcher is a
  window: `LazyCodeIndex` re-checks the working tree once its last pass is
  older than `RECHECK_AFTER_MS`, because a server that reconciled at startup
  would keep calling anchors on code the session just wrote unresolved. The
  re-check reuses the connection *and* the `CodeIndexer` — a second one would
  reload the grammar and hold a second parser for the life of the process —
  and a pass that throws still closes the connection it was handed, because
  nothing caches it afterwards. Two lifetime rules hold the pass together. A parsed tree is freed by `extract` itself:
  web-tree-sitter registers no `FinalizationRegistry`, so a tree handed to the
  GC keeps roughly thirty times the parsed bytes for the life of the process —
  which is a long-lived MCP server, not a command. And a file the pass cannot
  use is a *skipped file*, never a failed run: unreadable, oversized or binary,
  it goes into `IndexReport.skipped` with its reason, and `cortex index` and
  `doctor` name the first few through `cli/skipped-sources.ts`. An oversized
  file stays in the listing regardless, because an import can point at it —
  it is `computeDrift`, reading the same skip list, that keeps it from looking
  like drift forever.

  Two grammars are loaded, not one (`ensureGrammars`): `<T>expr` is a type
  assertion in `.ts` and a JSX element in `.tsx`, and parsed by the wrong one it
  becomes an ERROR node that swallows every symbol after it. `.ts` gets the
  TypeScript grammar, everything else the TSX one, because a `.js` file carries
  JSX far too often to risk the other way round. What the grammar could not read
  end to end is recorded per file rather than thrown: `IndexedFile.hasError`
  says the symbols are a prefix, never an inventory, and everything downstream
  reads it that way.

  An import's target is a fact about the whole file set, so the incremental pass
  cannot leave it to the importer's own bytes: adding a module used to leave
  every earlier import of it NULL forever, and renaming one left every edge into
  it pointing at a file that was gone. Whenever the file set moves, the pass
  re-resolves every edge in `imports` and writes only the rows that moved
  (`IndexReport.repaired`); `danglingTargets` is the same question asked of a
  store nobody reconciled, which is the one drift `computeDrift` cannot see.

  Staleness is `(size, mtime, ctime)`. The first two are both forgeable by an
  ordinary restore — `cp -p`, `tar -x`, `rsync -t`, a CI cache restore — and no
  userspace call can set an inode's change time. And the listing only guesses at
  generated output when nothing better answered: a git listing already came
  through `--exclude-standard`, so `dist` and `build` are dropped by the
  directory walk alone, never on top of the project's own `.gitignore`.
- `embedding/` — the hard part; see topology below.
- `release/` — self-update: resolve a GitHub release, verify its checksum,
  unpack the ustar member, replace the running binary by atomic rename. It
  imports nothing from the other `src/` directories except `support/`, on
  purpose: the upgrade path must not drag the store or the model in behind it.
  `replaceBinary` is the one place that rename is not one call — see below.
- `app/` — use cases; `runtime.ts` is the composition root. Use cases narrow
  `CortexRuntime` with `Pick<>` instead of introducing interfaces.
- `cli/` — hand-rolled dispatch table in `main.ts` (deliberate, no CLI
  framework); one file per command in `cli/commands/`. Four are `hidden`
  because another program invokes them, never a person: `prompt-hook` (Claude
  Code), `git-hook` (the installed git hooks), `embed-worker` and
  `embed-daemon` (the binary spawning itself). All four are spawned with pipes,
  so all four take a terminal on stdin as a person who found the name somewhere
  and print what they are instead of running.

  A file directly under `cli/` is something several commands share.
  `error-output.ts` is the single failure reporter: `--json` means the same
  thing on the error path as on the happy one, and `USAGE` — not a second list
  — decides which commands may answer that way, so a command that cannot print
  JSON on success does not invent it on failure. It owns `usageError` too,
  which is why `usage.ts` is the table alone. `arguments.ts` holds the three
  rules every command shares about its own argv: flags stop at `--`, a blank
  positional is a missing one, and a count is spelled in digits.
  `malformed-files.ts` caps how many unreadable decision files `doctor` and
  `sync` name and states the remainder, so neither can truncate silently and a
  corrupt checkout cannot bury every other finding. `skipped-sources.ts` is the
  same cap for the source files the code index could not use, shared by `index`
  and `doctor`. `confirm.ts` answers a confirmation in three values, not two:
  a declined prompt costs nothing, a prompt that could never be shown is a
  command that did nothing and has to say so.

  `open-runtime.ts` is where a store SQLite refuses to open is turned into a
  sentence: `decisions.db` is a derived cache and the files are the product, so
  `SQLITE_NOTADB` names the path and the rebuild rather than dying on "file is
  not a database" — reported, never repaired, because deleting a database on a
  read command is the one thing that cannot be taken back.
- `install/` — pure logic only, home and cwd passed in as parameters, 100%
  in-process coverage; the thin command files touch process state.
  `marked-block.ts` is the one marker fence, shared by the instruction block
  `init` writes into `CLAUDE.md` and the shell block `install --git-hooks`
  writes into a hook, and its `remove` is the exact inverse of its append —
  that is what lets uninstall hand a file the user owns back unchanged.
- `mcp/` — server with 6 tools; `RuntimeRegistry` caches one runtime per
  resolved project root, as an LRU capped at 8 that disposes what it evicts.
  A runtime is leased for the length of the handler (`withRuntime`), so the
  cache never closes one a call is still using. Recoverable states return
  `guidanceResult`, never `isError`. `search_all_projects` is deliberately
  unscoped (no `projectPath`): it fans out over `~/.cortex/projects.json` — a
  rebuildable per-user registry filled by `cortex init` and first use — and
  returns results grouped per project, never merged into one ranking. Scoped
  reads stay scoped; never fold cross-project search into them.
  Rebuildable is not disposable: a registry that is there but unreadable is
  renamed to `projects.json.corrupt.<timestamp>` before anything writes over
  it, and left alone when even that fails, because starting fresh drops every
  other project the user tracks. Reads never write — they filter, and only
  `registerProject` drops an entry, and only one `ProjectRoot` proves absent —
  and the state reaches the caller (`ProjectRegistryRead`) so a narrowed sweep
  says so instead of passing for a complete one.

**The fan-out opens foreign projects read-only.** `search_all_projects` and
`cortex search --all-projects` are annotated `readOnlyHint`, and clients run
them without prompting: a project the user only asked about goes through
`app/project-reader.ts` (a `query_only` connection and the three read
repositories), never `buildRuntimeAt`. No mkdir, no migrate, no bootstrap
export, no reconcile, no registration, and no entry in the runtime cache; a
store behind `SCHEMA_VERSION` is `skipped` with a reason, not upgraded. The
query is embedded once and the vector passed to every store, the label comes
from the registry instead of a `git` call per project, and the sweep is capped
by count and by deadline, with the remainder reported as `skipped`.

## Decisions are files, the database is a cache

**A decision file is immutable. Changing your mind writes a new file with
`replaces`; nothing ever rewrites an existing one.** This is what lets drift
detection be a plain set difference, lets `nodes_fts` stay insert-only, and
lets a stored vector outlive a branch switch without a content hash. If an
edit path is ever added, stored vectors and FTS rows go stale silently —
revisit a `content_sha` column that day, and not before.

- `nodes.present` is a working-tree fact (is the file on this branch?),
  `status` a product fact (was it superseded?). Orthogonal, never folded.
- An anchor is versioned; its resolution is not. `src/app/anchor-confidence.ts`
  grades every anchor against this checkout — `exact` (the anchored file
  declares that symbol), `name_only` (the symbol is indexed under another
  file), `file_only` (no symbol, or a symbol in a file the indexer does not
  cover), `unresolved` (the file left the working tree, or the symbol vanished
  from a file that is indexed) and `unknown` (the code index could not be
  read). The vocabulary is `ANCHOR_CONFIDENCES`, strongest first, which is what
  `strongestConfidence` reads. Computed on read, never stored: it is derived
  from `code.db` and the working tree, so writing it into the decisions store
  would give one derived cache a stale copy of another, and would make a read a
  write — which `prompt-hook` cannot be. `labelAnchors` skips the code index
  entirely when nothing on the payload is anchored, and degrades to `unknown`
  rather than to a wrong downgrade when the index is unavailable — *or* when it
  cannot answer inside `ANCHOR_INDEX_TIMEOUT_MS`. Grading is the only
  code-index read with an honest degraded form, so it is the only one on a
  deadline: reading the index reconciles it, and a cold repo reconciles the
  whole tree while an MCP client waits for decisions FTS already found.
  Nothing is cancelled, so the pass stays in flight and the next request is
  graded rather than starting over. `get_impact`, `save_decision` and
  `cortex why --symbol` keep waiting: without the index they have no answer to
  degrade to.
- The resolver reads the symbol table once, not once per anchor.
  `CodeRepository.symbolTable()` is a scan and a `symbolKey` per row — the
  price of a normalizer SQLite cannot run — so `IndexedAnchors` holds the
  `SymbolTable` it built and answers every later anchor from memory, and builds
  it only on the first anchor that is not already `exact`. `findSymbol` is the
  same read for callers with a single name. Per resolver, never cached across
  requests: the table is a copy of a store that reconciles underneath it.
- Nothing is deleted, ever. Switching branches flips `present`; a decision
  that comes back keeps its embedding and its row.
- Versioned in the file: the decision, its anchors, `DEPENDS_ON`,
  `REPLACED_BY`, `ARCHIVED_BY` (a file with `archives` retires a decision
  that has no successor), `CONFLICTS_WITH` (declared one-sided via
  `conflicts_with`, read symmetrically). Status is derived from `replaces`
  and `archives`, with `replaced` winning when both name the same decision.
  Local to the machine: session and project nodes,
  `BELONGS_TO`, `GENERATED_IN`, embeddings, `nodes_fts`, and how well each
  anchor resolves. A decision imported
  from someone else's branch has no `GENERATED_IN` — that session never
  happened here, and that is correct.
- Edge targets are validated against the store, not the branch. A dangling
  target is skipped and reported; inserting it would fail every command,
  because foreign keys are on.
- A retirement that closes a cycle — two files each superseding the other, or
  one naming its own id — is dropped and reported in `ReconcileReport.cyclic`
  rather than applied. Both facts are true and applying both retires both, so
  the pair would leave every surface at once with a clean report, and files
  are immutable, so there is no undo except writing another decision. A
  self-edge of any kind goes the same way, and `CHECK (from_id <> to_id)`
  keeps one out of the store — one reaching the insert would roll back the
  whole reconcile, on every command.
- Nothing a reconcile reads may throw, because every command runs one and the
  git hook swallows what it raises: `DecisionStore.read` answers a reason for
  a file it cannot read — `EACCES`, a directory named `<id>.md`, anything that
  is not a regular file — and the file lands in `ReconcileReport.malformed`,
  present-but-unusable, never absent. The directory itself is the one listing
  that cannot degrade to empty: `DecisionListing` carries the failure to the
  caller, because answering with no ids would retire every decision the store
  holds. A `.md` whose name is not a lowercase id and a `.partial` a killed
  write left behind are reported the same way — nothing else collects either,
  and both are invisible to loading.
- `save_decision` writes the file, inserts the row, then reconciles. Status
  and versioned edges are derived in exactly one place, so a decision saved
  here goes through the same path as one that arrived from a pull.
- `insertDecision` writes the node, its anchors and its FTS row in one
  transaction, because a node row without its FTS row is unrepairable: the
  reconciler only ever inserts ids it has never seen, so `--full` included, no
  pass would ever add the missing one back and the decision would sit on disk,
  listed by `cortex log`, unfindable forever. Nested in the reconcile it is a
  savepoint, which is what lets a decision the store refuses roll back alone —
  named as `malformed` and skipped, never taking the pass down with it. That
  matters because the pass is recomputed from the same files every run: a file
  that kills it once kills every command until a human finds it.
- Anchors are deduplicated on the way in, by `uniqueAnchors`, on the save path
  and the parse path alike. The pair is the primary key, a repeated entry says
  nothing the first says, and a file arrives by merge and hand edit as much as
  by `save_decision`. Nothing about this is normalization — an anchor is still
  stored exactly as written.
- The reconcile does not enqueue embeddings: a pull must not make `cortex log`
  load the model, and a CLI process disposes before the embed would finish.
  `cortex embed --missing` owns that, and doctor reports the pending count.
- `prompt-hook` never reconciles — it is read-only and must never migrate. It
  serves the previous view until the next command runs. Read-only to SQLite is
  not read-only to the filesystem, though: reading a WAL database creates
  `-shm`, so a `.cortex` the user cannot write is a store the hook cannot open,
  and it exits 0 in silence like every other failure. Its stdin is bounded in
  time and size for the same reason — a caller that holds the pipe open is a
  caller that will never finish, in front of a person waiting to type.
- Everything a decision file contributes to that output goes through
  `fenceSafe` first, and the truncation runs after the escape so a cut cannot
  reassemble a tag out of what it leaves behind. The fence is the only thing
  separating injected context from the user's own prompt, and a decision file
  arrives through any merged pull request. A file that spells the closing tag
  anyway is named in `ReconcileReport.fenceBreaking` and warned about by
  `doctor` — reported, never refused: the escape already made it harmless, and
  dropping a decision off the branch over a string is the larger damage.
- `git-hook` is its mirror image: reconciling is the whole job, so it opens the
  store read-write — but only when `decisions.db` already exists, so a hook can
  never conjure a store behind a commit. It bypasses `app/runtime` (which would
  register the project, may rewrite the config, and prints when uninitialized),
  returns 0 on every path so it cannot fail a commit, and spawns
  `embed --missing` detached after a commit or a merge only. Not after a
  checkout — a restored decision still has its vector — and not while git's
  sequencer has steps left: a rebase replays post-commit once per commit, so
  fifty replayed commits would load the model fifty times.
  `replayStepsRemaining` reads the todo file git rewrites before each of them,
  which is empty on the last one, so the whole replay costs one embed. It does
  not touch the code index.

## The usefulness sidecar ranks, it never selects

Which decisions proved useful is a fact about *this machine*, so it lives in
the same relation to the markdown as the SQLite caches do: derived, local,
deletable. The rule that keeps it honest is that it reorders results already
chosen, never chooses them — delete the sidecar and the ordering changes, the
result set cannot.

- A session here is a conversation, not a process. `SessionIdentity`
  (`support/session-identity.ts`) rolls the id after `SESSION_IDLE_MS` with no
  traffic, on a monotonic clock. Without that, an MCP server up for a week was
  one session for the week — and since promoting needs two distinct sessions
  while demoting needs one, it could only ever accrue the negative signal.
- Recorded, at most once per decision per kind per session
  (`UsefulnessRecorder`): `shown` from `get_context` **with an intent** and
  from `search`; `used` from `get_impact`, and from every id a `save_decision`
  cites in `depends_on`, `replaces`, `archives` or `conflicts_with`. The
  overview path of `get_context` records nothing — listing the most recent
  decisions is browsing, and counting it would mark every new decision as
  passed over. Neither does `search_all_projects`: a discovery sweep has no
  follow-through inside a project to observe.
- Scored by `usefulnessScores`: signed, halving every `HALF_LIFE_DAYS`. A
  positive counts only once `MINIMUM_CORROBORATING_SESSIONS` distinct sessions
  used the decision; a `PASSED_OVER_WEIGHT` negative lands only on a decision
  a session saw while acting on a different one — a session that used nothing
  may simply never have got there, and its silence is not a verdict. Both
  signs on one decision is the contested case, and the decayed sum settles it
  by recency.
- Applied after the top-K slice, ordering only results that share a
  `displayScore` — the very rounding every surface prints, so the rule is one
  a reader can check: results the printed score cannot tell apart are ordered
  by what proved useful here. `exact=true` is left alone; a literal lookup has
  no ties worth breaking.
- `UsefulnessEventLog` never throws and never blocks: an unreadable or
  unwritable log degrades to no signal. Compaction goes through
  `support/append-only-log.ts`, shared with the query log: it re-reads before
  publishing and puts the late tail back, so events another process appended
  during the pass are merged rather than replaced. A window of microseconds
  before the rename is left open on purpose, and the file says why no lock
  closes it.
  `CORTEX_NO_USEFULNESS=1` stops the recording; deleting the directory is the
  reset, and `doctor` reports the counts as a fact, never as an issue.

## One recipe for a symbol name

Three producers name the same symbol and none of them can see the other two:
the tree-sitter extractor reads it out of the source, an LLM writes it into an
anchor through `save_decision`, and the matching side reconciles the two. Let
them each normalize their own way and one symbol becomes two rows that never
meet. `src/support/symbol-key.ts` holds the recipe once, and the order of its
steps is load-bearing: every step that can *expand* a character runs before the
step that drops characters. Compatibility decomposition expands a ligature into
its letters, and so does case mapping — lowercasing the Turkish dotted capital I
yields `i` followed by a combining dot above, one code point becoming two.
Filter first and that mark survives into the output for a second pass to remove,
so the function is no longer idempotent and the extractor disagrees with the
matcher on every Turkish identifier. Sweeping the code points, that capital is
the only character that breaks idempotence under the wrong order; one is enough.
`tests/support/symbol-key.test.ts` pins idempotence and the output character
class as properties, not examples.

The recipe is exposed at two stages of the same pipeline, never as two functions
with two truths. `canonicalSymbolName` stops before the case fold and is what
`insertSymbols` stores, because that name is handed back as a suggestion and an
LLM copies it into a decision file, which is immutable once written — the index
is the only place the human spelling survives, so it keeps it. `symbolKey` runs
the fold too and is what every comparison uses: `hasSymbol`, `SymbolTable`
(which `findSymbol` reads through), the parameters `suggestSymbols` feeds to
`src/storage/queries/match-symbols.sql`, and `listByFileAnchorOrSymbol` — the
fourth site, and the one inside `decisions.db`, where no normalized key is
stored and none should be. SQLite cannot run the recipe, so that query keeps
only the file half in SQL and hands every anchor on that file to `symbolKey`
here; a `symbol_key` column would be a second copy of the recipe, free to go
stale against it, and `anchors` is small enough that the filter costs nothing.
A property test
pins `symbolKey` composed with `canonicalSymbolName` to `symbolKey` alone, which
is what makes storing the canonical form free of consequence. Normalization
never touches `.cortex/decisions/`: an anchor is compared normalized and stored
verbatim.

Because the stored spelling changed, `EXTRACTION_VERSION` went to 2 — rows an
older writer left behind keep the source's own spelling and would match neither
a fresh row nor the suggestion query. Bump it again for any change to this
recipe.

## The query log is off until someone turns it on

The usefulness sidecar and the query log are the same machine with opposite
defaults, and the difference is the content, not the taste. Usefulness records
decision ids and timestamps — facts about rows this store already holds, which
is why it can record on a read-only path and default to on. A query log records
the *text of the questions*: proprietary content, in a file no repository's
`.gitignore` or retention policy was written for. A default-on record of that
contradicts the on-device posture, so it defaults off and says so.

- Three environment variables, read once per runtime by `QueryLogSettings`:
  `CORTEX_QUERY_LOG=1` enables, `CORTEX_QUERY_LOG_PATH` relocates the file,
  `CORTEX_NO_QUERY_LOG=1` disables — and the disable wins over the enable, so a
  machine told to stay quiet stays quiet when a later config turns the flag on
  somewhere it cannot see. An explicit path says *where*, never *whether*.
- Recorded: the intent or the terms, `exact`, the `module` filter, the result
  count, and the head of the returned ids — enough to replay a case and judge
  the ranking. Not recorded: titles, bodies or scores (derived, and the ids
  resolve against the store), the cross-project sweep (no single store a
  fixture could be replayed against), and the prompt behind `prompt-hook` —
  that is whatever the user typed, on every prompt, and logging it would make
  an evaluation aid into a keylogger.
- `QueryLog` never throws and never reads on the write path: one short append
  per query, and one `stat` to decide whether the file is over `MAXIMUM_BYTES`.
  The ceiling is bytes rather than rows because the file holds the text of the
  questions, and it is read off the file rather than counted per instance — a
  CLI process makes one query and exits, so a counter would enforce nothing
  anywhere but the server. Compaction trims to `COMPACTED_BYTES`, half the
  ceiling, so it is amortized instead of firing on every later query.
- Reading is not recording, so the log stays readable while recording is off:
  that is how `doctor` reports a log an earlier opt-in left behind instead of
  pretending nothing was ever written. Every state is a fact, never an issue.
- `observedQueries` is the consumer: real traffic, deduplicated by question and
  ordered by how often it was asked, as *candidates* for `tests/evaluation/`.
  What the log holds is what the ranking returned, which is the thing a case
  exists to judge — promoting one into the ground truth stays a human act.

## The benchmark measures the economy, never the quality

`cortex benchmark` answers one question: how many tokens does an agent read to
get an answer, against how many it would read without cortex. It is the
context-size half of the evaluation; `tests/evaluation/` is the retrieval half,
and neither substitutes for the other.

- The questions are the corpus asking about itself — one per active decision,
  its own title, ordered by id (`questionsFromDecisions`). Fixed for a given
  corpus and derivable in any project, where the graded PT/EN paraphrases in
  `tests/evaluation/ground-truth.ts` only ever fit this one. That makes the
  reported hit rate a ceiling, not a measurement: `bun run eval:search` stays
  the authority on recall, and the benchmark says so in its own output.
- The grep baseline charges one term at a time, never their union
  (`RepositoryCorpus.grepCosts`). Half the words in any question are
  connectives that match nearly every file, so a union measures the stopwords.
  Two single greps are reported instead: the narrowest term, which is the floor
  of the alternative and the number the claim should be judged on, and the
  median term.
- `TOKEN_METHOD` travels with every number. The count is deterministic and
  approximate — calibrated to 1.03x a real SentencePiece tokenizer over this
  repo — and a ratio of two counts by the same rule is what the command
  actually claims.
- `--write` regenerates `BENCHMARKS.md` in place, and the command is the only
  thing that writes it. A benchmark a person keeps up to date is a benchmark
  that is wrong by the next commit; the file it writes excludes itself from the
  repository it measures, so a second run reports what the first one did.
- Known difference from graphify, checked and deliberately not copied: its
  benchmark degrades box-drawing and arrows to ASCII because CPython encodes
  stdout through the locale codec and raises mid-output on a cp1252 console.
  That failure mode does not exist in Bun — there is no encoder between a JS
  string and the fd, and a C locale still emits the same UTF-8 bytes and exits
  0. So `src/cli/style.ts`, `src/cli/commands/impact.ts` and
  `src/cli/commands/sync.ts` keep their glyphs and no ASCII fallback is added:
  the residual risk is a legacy console *rendering* them wrongly, never a
  command failing. The benchmark's own table is ASCII regardless, because a
  table is the one place box drawing would have been tempting.

## Embedding process topology

Three processes, reachable as hidden CLI subcommands (`prompt-hook`,
`embed-worker`, `embed-daemon`) so the compiled binary can spawn itself
(`embedding/subprocess-command.ts`):

- CLI commands spawn a private worker subprocess (NDJSON on stdio, WASM
  transformers.js — native addons would break the single-file binary).
- The MCP server prefers the per-user shared daemon (Unix socket), falling
  back to a private worker.
- Degradation ladder — never weaken it: shared daemon → private worker →
  pure FTS. Every rung is reachable from the one above at any point of a
  request, not only while dialling it: `shared-provider.ts` retries on the
  private worker when the daemon leg fails for a *transport* reason, which the
  connection itself distinguishes — a daemon that answered `error` is still
  open and returned a verdict the private worker would only repeat. The vector
  path never blocks a query: every await on it is bounded by a timeout, and FTS
  answers when one fires. The two kinds differ on purpose: an embed disposes of
  the worker on timeout (`embedding/queue.ts`, `cli/commands/embed-all.ts`,
  `embedding/daemon/embedding-daemon.ts`), while a query leaves it alone
  (`embedding/semantic-search.ts`, and the same daemon method reading
  `request.kind`) so a model still loading after an idle-kill finishes for the
  next query instead of restarting.
- The daemon serves one worker to every session, and the worker embeds one
  request at a time, so the daemon queues rather than pipelines: a request's
  deadline starts when it reaches the worker, never while it waits behind
  another session (`embedding/serial-lane.ts`).

`prompt-hook` bypasses `app/runtime` and opens the database read-only on
purpose: it runs on every prompt and must never fail or migrate state.

## Fetching the model is not embedding

The first run downloads about 300 MB of weights, and for a long time that
happened inside the first `embed` request — under the deadline that exists to
catch a *wedged* worker. On any link slower than roughly 10 MB/s the download
was killed at 30 s, the partial fetch discarded, and the next invocation
started from zero: embedding was not slow on that machine, it was impossible.
A worker fetching a model is not a hung worker, and the two must never share
one budget.

- `cortex embed --fetch-model` is the explicit acquisition step, with no
  deadline at all — a person who invoked it can interrupt it, where a
  background embed cannot. It skips `app/runtime` entirely: which model is on
  this disk is a fact about the machine, not about a project, so the command
  answers outside any store.
- The implicit path is not left unrecoverable. `embedDeadlineMs` in
  `embedding/model-cache.ts` swaps the inference deadline for
  `MODEL_ACQUISITION_TIMEOUT_MS` while the model is not yet resident, at every
  site that applies one — the queue, `embed-all`, and the daemon. It stays
  bounded: a download that is genuinely stuck is still reported.
- Residency is a stamp the worker writes (`markModelResident`), never the
  presence of the cache directory: transformers.js creates that directory
  before the first byte lands, so a run killed mid-download leaves one that
  looks finished. The marker lives inside the model directory, so deleting the
  model deletes the verdict with it, and `doctor` reports all three states —
  downloaded, cache present but unconfirmed, absent.
- A provider that cannot answer `modelResident` is taken at the configured
  deadline. Only the process that would spawn the download knows there is one
  to wait for, so a fake or a stub must not silently inherit a 15-minute
  budget.
- The worker narrates the download on stderr (which the parent inherits) and
  only while acquiring: transformers.js reports the same progress for a file it
  streams out of the cache as for one it fetches, so a resident model would
  otherwise print a progress bar on every cold start.

## Windows is a platform, not a port

Packaging Windows was one more entry in `RELEASE_SUFFIXES`. Everything that
took work is somewhere the platform does not have the primitive the code was
written against, and each of those places takes the answer as a **default
parameter** rather than reading `process.platform` inline: the branch a host
cannot reach is still a branch the suite has to drive, and `RUNS_ON_WINDOWS`
(`src/support/platform.ts`) is the value they default to.

- **The daemon has no socket file.** A named pipe is a name in a namespace the
  kernel owns, created and removed with the process listening on it, so
  `daemonPathsFor` answers a pipe there and keeps the lock and the log as
  files — they are what a second process reads to find the daemon at all. That
  namespace is machine-wide, so the owner is part of the pipe's name; without
  it two accounts would race for one daemon and the loser would be handed the
  other's. Nothing about the degradation ladder changes: a pipe that cannot be
  reached is `unreachable`, which is the rung the private worker already
  answers.
- **A running image cannot be renamed over.** The loader holds it open without
  delete sharing, so `replaceBinary` renames the running binary *away* first
  and puts the new one in its place — both renames or neither, because a
  failure between them leaves the install directory with no cortex at all.
  Deleting what it retired is the one step the process running that image
  cannot take; the next upgrade sweeps it, through the same `LEFTOVER` scan
  that reclaims an interrupted upgrade's staging file. The staging name keeps
  an `.exe` tail there, because the version probe runs that file before
  anything is replaced and Windows only launches a path it will treat as an
  image.
- **The tarball carries `cortex.exe`.** Which name arrives is a fact about the
  asset and not about the host reading it — an upgrade unpacks whatever it was
  handed — so `readCortexBinary` accepts either, and `executableNameFor` in
  `scripts/compile.ts` spells the name from the target rather than from the
  builder.
- **git's `sh` reads a backslash as an escape.** Git for Windows runs hooks
  through the shell it bundles, and that shell takes a drive-letter path as
  long as it is spelled with forward slashes. `selfCommand` produces that
  spelling — the conversion belongs where the path is made, not at every place
  that quotes it — and `isShellSafeCommandWord` accepts a drive as a root
  beside the empty one an absolute POSIX path leaves.
- **`import.meta.url` is not a path.** Its `.pathname` hands back a leading
  slash before the drive letter, which no `spawn` and no `fs` call will
  accept, so every site that derives a path from a module URL goes through
  `fileURLToPath`.
- **One asset, both architectures.** Bun cross-compiles no Windows arm64 build
  and Windows on ARM runs an x64 image under emulation, so `targetForHost`
  answers the same suffix for both — and there is no baseline variant, because
  neither side can read a CPU feature list there and a suffix nothing can
  select would only ever be wrong.
- **`install.ps1` is the second implementation of the same rule**, the way
  `install.sh` is on POSIX, and it drifts the same way: CI runs its `Get-Suffix`
  against `targetForHost` on a Windows runner. That job lives in the gate and
  not after the release, because PowerShell is the only thing that parses that
  file — a syntax error found after the tag is a published release nobody can
  install.

Linux stays the platform the suite runs on. macOS and Windows get the compiled
artifact driven end to end instead, which is what a cross-compiled binary
actually has to prove.

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
- A release tarball holds three members — `cortex` first, then `LICENSE` and
  the third-party notices, which `scripts/notices.ts` derives from that
  target's own `main.js.map` rather than from the dependency graph: 149
  packages install here and 12 reach the binary. A `type: "file"` asset leaves
  no sourcemap entry, so the packages behind those imports are read off `src/`
  and unioned in. A bundled package that ships no license text is a build
  failure unless its text is vendored under `scripts/licenses/`, and nothing
  degrades to naming a license it cannot show. `release/archive.ts` already
  scans past members it does not want, so the upgrade path is indifferent to
  the two text files. Tests reach `scripts/notices.ts` through the
  `tsconfig.json` path alias that mirrors the one `tests/` uses.
- The gate a tag passes is the gate a branch passes: `release.yml` calls
  `ci.yml` as a reusable workflow instead of restating a subset of it, then
  unpacks the tarball it is about to publish and drives *that* binary through
  `scripts/compiled-smoke.ts`, which takes `CORTEX_SMOKE_BINARY` and skips its
  own compile. Assets are attested with Sigstore because `checksums.txt` is
  served by the origin it verifies — it detects corruption, not substitution.
  `tests/docs/` asserts both, and asserts the version in `package.json`
  reaches `CHANGELOG.md`, the README's install pins and the `BENCHMARKS.md`
  stamp — the drift that let 0.4.0 ship twice.
- Coverage counts only files imported in-process: `src/cli` is exercised by
  spawning the CLI from `tests/cli/`, keeping it out of the coverage report.
  A file that never loads in-process is therefore invisible rather than 0%, so
  `scripts/coverage-audit.ts` holds the explicit list of files allowed to be
  absent (subprocess-covered or type-only) and fails on anything else — a new
  untested file cannot slip past the threshold. Both directions are checked:
  an exemption that becomes instrumented or deleted fails too.
- Every name this file puts in backticks is asserted by
  `tests/docs/claude-md.test.ts`: a path must resolve in the tree, a hidden
  command must have a file under `cli/commands/`, and a multi-word identifier
  must appear in `src/`, `scripts/` or `install.sh` with comments stripped —
  a name that survives only in a comment, in a test or in a derived store has
  not survived. Spans matching none of those shapes are ignored, so a
  minimum-match floor guards the extractor itself. A name that deliberately
  does not exist — `content_sha` is the standing example — goes in that
  test's exemption map with its reason, checked in both directions like the
  coverage audit.
- Every number in `README.md` is a quote from a command's output, and
  `tests/docs/readme.test.ts` is what keeps it one: the CLI block must document
  every command `cortex --help` advertises and no hidden one, carrying every
  flag and placeholder `USAGE` gives it; the benchmark table must equal
  `BENCHMARKS.md` cell for cell; the recall claim must count the cases
  `tests/evaluation/ground-truth.ts` actually holds; and the manual MCP snippet
  must parse as strict JSON and name the command `resolveServerSpec` would.
  `tests/docs/distribution.test.ts` does the same for `RELEASE_SUFFIXES`, the
  one list `docs/distribution.md` describes in prose.

## Dogfooding

This repo records its own technical decisions in `.cortex/decisions/`
(committed; the two `.db` files are gitignored and rebuilt on demand). After a
decision is confirmed, save it through the real interface — `save_decision`
against `cortex serve --mcp` — then run `cortex embed --missing` and
`cortex doctor`, and commit the new markdown file with the change it explains.

`tests/evaluation/ground-truth.test.ts` reads those files and asserts every
id it cites is still an active decision here, so deleting or superseding one
breaks the suite on purpose.

`BENCHMARKS.md` is generated, never edited: after a batch of decisions lands,
run `bun run benchmark` and commit the file with them. The README repeats that
table for readers who never open the file, so update its copy in the same
commit — `tests/docs/readme.test.ts` fails until the two agree.

<!-- cortex:begin -->
## Cortex — decision memory

This project records its technical decisions with cortex (MCP server
`cortex`, tools: `save_decision`, `save_session_summary`,
`get_context`, `get_impact`, `search`, `search_all_projects`).

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
