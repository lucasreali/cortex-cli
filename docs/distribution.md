# Distribution

How a commit becomes a binary on a user's machine. Four pieces carry it, and
they are separate on purpose: `scripts/` builds and packages, `install.sh`
brings the first binary in, `src/release/` replaces one that is already there,
and `.github/workflows/` runs the whole thing from a tag.

```sh
curl -fsSL https://raw.githubusercontent.com/lucasreali/cortex-cli/main/install.sh | sh
```

GitHub Releases is the only source of artifacts. Every later channel — a
Homebrew tap, an npm wrapper — would consume the same ones.

## The assets

`src/release/target.ts` holds `RELEASE_SUFFIXES`, the single list of variants,
and everything else compiles from it or selects out of it:

| Bun target | Asset suffix | For |
| --- | --- | --- |
| `bun-darwin-arm64` | `darwin-arm64` | Apple Silicon |
| `bun-darwin-x64` | `darwin-x64` | Intel Macs |
| `bun-linux-x64` | `linux-x64` | glibc, AVX2 |
| `bun-linux-arm64` | `linux-arm64` | glibc |
| `bun-linux-x64-musl` | `linux-x64-musl` | Alpine, distroless |
| `bun-linux-arm64-musl` | `linux-arm64-musl` | Alpine, distroless |
| `bun-linux-x64-baseline` | `linux-x64-baseline` | x64 CPUs without AVX2 |

A release therefore carries 15 files: one `cortex-vX.Y.Z-<suffix>.tar.gz` and
one `cortex-vX.Y.Z-<suffix>.js.map` per target, plus a single `checksums.txt`
in `sha256sum -c` format covering the other fourteen.

Windows is not among them. The shared embedding daemon binds a Unix socket
(`src/embedding/daemon/paths.ts`), which is a verification pass of its own
rather than one more packaging flag.

## Build

`scripts/compile.ts` is the one call to `Bun.build`, and both `build.ts` (this
host, into `dist/cortex`) and `package-release.ts` (every target) go through
it. Two things there are not defaults:

- **The native-module plugin.** transformers.js imports `sharp` and
  `onnxruntime-node` at module top level; cortex pins the WASM execution
  provider and never reaches them, so the bundle carries throwing stubs
  instead. This is why the build stays on the `Bun.build` JS API — the plugin
  cannot be expressed through `bun build --compile`.
- **`define` for `CORTEX_BUILD_TARGET`.** The asset suffix is baked into each
  cross-compiled binary, because musl and baseline builds are indistinguishable
  from the inside at runtime. `cortex upgrade` reads it to know which asset it
  is. A locally built binary has nothing baked and falls back to describing its
  host through `targetForHost(currentHost())`.

`scripts/package-release.ts` compiles each target into `dist/stage/<suffix>/`
and archives exactly one entry — `cortex`, mode 0755, mtime 0, `--format=ustar`
with `--numeric-owner`. Bun writes the gzip wrapper, so the `tar` binary is
left with flags GNU tar and bsdtar both accept; `--owner`/`--group` are the
exception, tried first and dropped if the libarchive on the builder rejects
them. Each target keeps its own sourcemap: the bundles differ by that one
`define`, so a shared map would mislocate frames for six of the seven.
Sourcemaps ship as separate assets and never inside a tarball.

```sh
bun scripts/package-release.ts
cd dist/release && sha256sum -c checksums.txt
tar -tzf cortex-v0.4.0-linux-x64.tar.gz   # exactly: cortex
```

## install.sh

POSIX `sh`, `set -eu`, never `sudo`, and `curl` plus `tar` are all it needs.
`CORTEX_VERSION` pins a release (with or without the `v`),
`CORTEX_INSTALL_DIR` moves the destination from `$HOME/.local/bin`.

- **Suffix detection** (`detect_suffix`) asks `uname`, then `ldd --version` and
  the musl loader paths, then `/proc/cpuinfo` for `avx2`. A cpuinfo it cannot
  read means "no AVX2", which selects the baseline build — the safe answer,
  since baseline runs on either CPU while an AVX2 build meets a machine without
  it as an illegal instruction.
- **Version resolution** follows the `/releases/latest` redirect rather than
  calling the GitHub API, so it needs no token and never meets the
  unauthenticated rate limit.
- **Transport** pins https on the first request *and* on every redirect
  (`--proto =https --proto-redir =https`): `-L` alone would follow a downgrade
  to plain http, over the same channel the checksum arrives on.
- **Verification** is not optional. The asset's line is looked up in
  `checksums.txt` by exact filename, and a name that is not listed is a
  failure, never a skip.
- **Replacement** stages inside `$INSTALL_DIR`. `mktemp` lands in tmpfs, and
  `mv` across filesystems unlinks the destination and copies into a fresh
  inode, which leaves an executable, half-written `cortex` on disk for the
  length of the copy. The staged binary must answer `--version` with the
  version that was asked for before the rename happens, so a
  wrong-architecture download is caught while the working binary is still in
  place. Same shape as `src/release/installer.ts`.

Sourcing it with `CORTEX_SOURCE_ONLY=1` exposes the functions without
installing anything, which is how CI compares `detect_suffix` against
`buildTarget()`.

## cortex upgrade

The same contract, re-expressed in TypeScript against the binary that is
currently running. It imports nothing from the rest of `src/` except
`support/`: the upgrade path must not drag the store or the model in behind it.

- `release/target.ts` — which asset this binary is, plus the tag grammar and
  the URL builders. `CORTEX_RELEASE_BASE_URL` is a test seam, not a setting: an
  installed binary takes the override only for an address on `github.com`,
  because whatever it names is downloaded, executed once for a version probe
  and then renamed over the running binary.
- `release/catalog.ts` — resolves the tag through the `/releases/latest`
  redirect, exactly as `latest_version()` does, then downloads the asset and
  `checksums.txt`.
- `release/checksums.ts` — verifies the one line naming the asset that was
  downloaded, the same discipline install.sh applies with `awk`.
- `release/archive.ts` — gunzip plus a ustar reader for the single member named
  `cortex`. Reading it in-process rather than shelling out to `tar` keeps the
  "no runtime dependencies" promise, and it can only ever extract that one
  member, so a hostile archive has nowhere else to write.
- `release/installer.ts` — the running executable cannot be written into
  (`ETXTBSY`), so the replacement is staged beside the target on the same
  filesystem, chmodded, and made to prove it runs by answering `--version`
  before the old one is given up.

`--version` accepts a downgrade; the explicit flag is the consent. `--check`
never writes and works from a source checkout, which is what lets the CLI tests
exercise version resolution without a compiled binary. Installing from a source
checkout is refused outright.

## CI and the release workflow

`ci.yml` runs on every branch push and pull request: `lint:ci`, `typecheck`,
`test:coverage` at the 100% line and function threshold, `coverage:audit`, and
a second job that runs `smoke:compiled` and then asserts the two suffix
implementations agree —

```sh
from_shell=$(CORTEX_SOURCE_ONLY=1 sh -c '. ./install.sh; detect_suffix')
from_typescript=$(bun -e 'import { buildTarget } from "./src/release/target";
  delete process.env.CORTEX_BUILD_TARGET;
  console.log(buildTarget());')
test "$from_shell" = "$from_typescript"
```

They are separate implementations because install and upgrade run in different
worlds; this is the check that keeps them from disagreeing about the host.

`release.yml` triggers on a `v*` tag and runs three jobs in sequence:

1. **verify** — asserts the tag matches `package.json`'s version (a mismatch
   would ship a binary that reports the wrong version in the daemon handshake),
   then `typecheck`, `bun test` and `smoke:compiled`.
2. **release** — `bun scripts/package-release.ts` builds all seven targets in
   one job, then `gh release create "$GITHUB_REF_NAME" dist/release/*
   --generate-notes` publishes them with the built-in `GITHUB_TOKEN`.
3. **verify-darwin** — on `macos-latest`, downloads its own `darwin-arm64`
   asset from the release that was just published, verifies its checksum line,
   and runs `--version`, `upgrade --check --json`, `init --yes` and `index` in
   a throwaway git repo. Everything is cross-compiled on Linux, and this is the
   one artifact that gets executed on the platform it was built for.

Both workflows cache `~/.cortex/grammars` — and the model and onnxruntime
assets for the smoke job — keyed on the files that pin them.

## Signing

Builds are unsigned, and nothing signs `checksums.txt`: the trust root is TLS
plus the integrity of the GitHub account. A binary fetched by `curl` and moved
into place is not quarantined — the attribute comes from browser downloads — so
the installer path runs fine on macOS, while a tarball downloaded by hand needs
`xattr -d com.apple.quarantine`. Notarization needs a paid Apple Developer
account and a signing job in CI, and is worth that only if manual downloads
become a common path.

## Upgrades and the daemon

Worth knowing, because it looks like a bug and is not: the daemon socket is
keyed by model id, not by version (`src/embedding/daemon/paths.ts`), so a
freshly installed binary can find a daemon from the previous version still
listening. The handshake handles it — `daemon/client.ts` rejects a hello whose
version does not match — but a rejected probe deliberately does not spawn a
replacement, so every session would degrade to a private worker until the old
daemon's idle timeout expired.

`cortex upgrade` therefore ends that state on purpose: after a successful
replacement it reads the daemon lock and sends `SIGTERM`
(`src/embedding/daemon/stop.ts`), and the next session spawns a daemon on the
new version. Killing it is safe because of the ladder — an in-flight request
falls back to a private worker, and the query path's timeouts guarantee FTS
answers regardless.

What users still need to know is that an MCP server already running inside
their editor keeps the old binary in memory until the client restarts it.

## Not shipped

1. **Homebrew tap** — `lucasreali/homebrew-tap`, a formula pointing at the
   darwin and linux tarballs with their checksums. Near-free on top of what
   already exists.
2. **npm wrapper** — a thin root package plus per-platform
   `optionalDependencies` carrying the same binaries. Requires dropping
   `private: true` and confirming the name on npm; if `cortex-cli` is taken,
   scope it and keep the command `cortex`.
3. **Windows** — packaging is one more Bun target; the work is the Unix socket
   in the shared daemon.
4. **Notarization** — see Signing above.
