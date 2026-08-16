# cortex-cli — improvement backlog

Source: comparative review against the sibling project `graphify`
(`../graphify`, Python, ~42k lines) on 2026-08-14. graphify solves a different
problem — a derived code graph, not versioned decision memory — but it has
already hit several operational problems cortex either has open or will reach.

Ordered by leverage. Each item states what to build, why it matters here, and
where the reference implementation lives in graphify.

---

## Low priority / watch

### 15. A rebase spawns one `embed --missing` per replayed commit

Found while measuring hook behavior for item 13, not from graphify.

`shouldEmbed` in `src/cli/commands/git-hook.ts` excludes only `post-checkout`,
and its comment explains why: "replays post-checkout once per commit, and each
embed loads the model." Measured against git 2.53, that is the wrong hook — a
rebase fires `post-checkout` once, and `post-commit` once per replayed commit.
Since `post-commit` does embed, rebasing fifty commits spawns fifty detached
`cortex embed --missing` processes, each of which loads the embedding model.

The exclusion of `post-checkout` is still correct, but for the reason
`CLAUDE.md` already gives — a restored decision keeps its vector — not the one
the comment gives. Fixing this means correcting the comment and deciding how
`post-commit` should behave mid-rebase; git sets `GIT_REBASE_TODO` and the
rebase state directory is observable, so the hook can tell a replay from an
ordinary commit and leave the embed to the end.

---

## Done

Closed on 2026-08-15, in one pass over the low-priority section.

- **10. Corrupt cache entry is not a cache miss.** The premise was half wrong:
  a decision file that fails to parse was never silent — `reconcile.ts`
  collects it into `malformed` and `doctor` warned about it. What was missing
  was the other half of graphify's lesson, the aggregate: the log was one line
  per file and unbounded, so a corrupt checkout buried every other check.
  `src/cli/malformed-files.ts` now holds the cap (5) and the omission line in
  one place for both `doctor` and `sync`; the omission line names
  `cortex sync --json`, which stays uncapped so exactly one complete,
  machine-readable list always exists.
- **11. Atomic write: symlinks and file mode.** Both behaviors adopted in
  `src/support/atomic-write.ts`, in both the async and sync twins through
  shared helpers so they cannot diverge. `linkTarget` resolves the leaf link
  chain before the staging path is chosen — which is what keeps the staging
  file on the target's filesystem, where rename is atomic — and stops after 40
  hops, matching Linux, so a cycle ends instead of spinning. `adoptMode` copies
  the destination's permission bits onto the staging file; an absent
  destination and a chmod we lack permission for are one `catch`, because both
  mean "leave the umask default alone". Consequence worth knowing: cortex now
  writes *through* a symlink at a managed path rather than replacing it.
  `install --git-hooks` is unaffected — it already refuses a symlinked hook
  path before reaching the writer.
- **12. Generated agent-facing docs with a CI drift check.** Adopted in half.
  The generator was rejected on the reasoning already in this file, and it is
  worth stating why sharply: cortex has one `CORTEX_INSTRUCTIONS_BODY`, written
  verbatim to every target, which differs only in filename — a generator here
  would be an identity function wrapped in a manifest, and nothing generated is
  committed to this repo anyway. The `--check` half was adopted, because it had
  a live failure: the `<!-- cortex:begin -->` fence this repo dogfoods in
  `CLAUDE.md` still listed five MCP tools after `search_all_projects` made six.
  `tests/docs/claude-md.test.ts` now asserts the fenced block equals the
  constant by asking `INSTRUCTIONS_BLOCK.upsert` what it *would* write, which
  reuses the recipe rather than re-parsing markers and makes a missing or
  malformed fence fail loudly instead of passing vacuously.
- **14. The fourth symbol comparison site.** Closed with the read-time
  TypeScript comparison, not the `symbol_key` column — the `006-` slot is still
  free. `listByFileAnchorOrSymbol` keeps the file half in SQL and now returns
  every anchor on that file for `symbolKey` to judge in TypeScript, so all four
  producers share one recipe. `SELECT DISTINCT` had to go with it (the anchor
  column makes sibling rows differ), replaced by a `Map` dedupe on node id that
  preserves the old ordering. The file-level anchor (`''`) is still compared
  raw, so a symbol that merely normalizes to empty is not promoted into one.
  `EXTRACTION_VERSION` deliberately not bumped: nothing stored changed, so a
  re-index would fix nothing and would cost every user one.

---

## Explicitly not adopting

- **`post-rewrite` as a fourth git hook.** Not deferred — redundant. Measured
  against git 2.53 with the default merge backend, a rebase fires
  `post-checkout` **once** (moving onto the new base, third argument `1`), then
  `post-commit` **once per replayed commit**, then `post-rewrite` once at the
  end; a `git commit --amend` fires `post-commit` and then `post-rewrite`. So
  `post-commit` — which `cortex install --git-hooks` already installs, and
  which reconciles — covers both the amend and the replay. There is no gap for
  a fourth hook to close, and `decisions.db` is a derived cache whose reconcile
  is idempotent even if there were. An earlier draft of this item claimed a
  rebase fires `post-checkout` once per replayed commit; it does not, and
  `src/cli/commands/git-hook.ts` still carries that mistake in a comment (see
  the open item above).
- **Module size.** `graphify/extract.py` is 6,719 lines and `cli.py` is 4,224.
  The 25+ language extractors explain part of it, but the organization did not
  keep up — the repo ships an `extractors/MIGRATION.md` acknowledging it. This
  is the opposite of the standards in `CLAUDE.md`.
- **Issue-number comments.** graphify comments carry dense issue references
  (`#2614`, `#1939`). Most of them document *why an alternative was rejected*,
  which is exactly the criterion for a legitimate comment here — but that
  knowledge is what `.cortex/decisions/` stores in this repo, which is an
  argument for cortex's design rather than a reason to copy the practice.
