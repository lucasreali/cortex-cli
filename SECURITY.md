# Security policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/lucasreali/cortex-cli/security/advisories/new)
— not a public issue, and not a pull request that fixes it, since a fix in the
open is a disclosure. Expect a first reply within a week.

Include what a report needs to be actionable: the version (`cortex --version`),
the platform, what an attacker gains, and the smallest sequence that shows it.

## Supported versions

Only the latest release is supported. Fixes ship in a new release rather than
as patches to an older tag; `cortex upgrade` moves an installed binary to it.

## What is in scope

The parts of this project that handle input somebody else wrote:

- **The upgrade path.** `cortex upgrade` fetches a release over https, refuses
  any origin but github.com, verifies the tarball against `checksums.txt`
  *before* unpacking, and proves the new binary runs before replacing the old
  one. `install.sh` does the same from a shell.
- **The prompt hook.** `.cortex/decisions/` arrives with a pull, and every
  prompt renders it. A decision file that escapes its fence and reaches the
  agent as instructions is a vulnerability, not a formatting bug.
- **Decision files and the reconcile.** A file written by someone else must not
  corrupt the store, execute anything, or write outside the repository.
- **The MCP server**, including the cross-project sweep: a broken or hostile
  project on the machine must not compromise the projects around it.

## What is not

- The embedding model download from HuggingFace, and the tree-sitter grammar
  download — both are third-party distribution channels, both cache under
  `~/.cortex/`.
- Anything reachable only by someone who can already write to your repository
  or run code as you.
- The local databases: `decisions.db` and `code.db` are derived caches, and
  `cortex sync` rebuilds them from the files.

## What the binaries are signed with

Nothing, on macOS: the builds are unsigned and Gatekeeper quarantines a
tarball downloaded in a browser. What they do carry is a Sigstore provenance
attestation binding each asset to the workflow, commit and repository that
built it:

```bash
gh attestation verify cortex-v0.0.0-darwin-arm64.tar.gz --repo lucasreali/cortex-cli
```
