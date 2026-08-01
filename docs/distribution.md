# Distribution: `curl -fsSL | sh`

Step-by-step plan to ship `cortex` as a standalone binary installed by a shell
one-liner, with GitHub Releases as the source of truth for artifacts.

Target end state:

```sh
curl -fsSL https://raw.githubusercontent.com/lucasreali/cortex-cli/main/install.sh | sh
```

Every later channel (npm wrapper, Homebrew tap, mise) consumes the same release
artifacts. Build them once, correctly, and the rest is packaging.

---

## Step 0 — Decisions to make before writing code

**Repository name.** The current remote is
`https://github.com/lucasreali/cortext-cli.git` — `cortext`, with an extra `t`.
That string ends up inside the install URL every user pastes, and inside every
release asset link. Rename the repo now if it is a typo; GitHub redirects the
old name, so nothing breaks. Everything below assumes `cortex-cli`.

**Platforms for v1.** Ship macOS and Linux. Skip Windows: the shared daemon
binds a Unix socket (`~/.cortex/daemon/<model>.sock`, `daemon/paths.ts`), and
that needs its own verification pass rather than a packaging flag.

| Bun target             | Asset suffix     | Notes                          |
| ---------------------- | ---------------- | ------------------------------ |
| `bun-darwin-arm64`     | `darwin-arm64`   | Apple Silicon                  |
| `bun-darwin-x64`       | `darwin-x64`     | Intel Macs                     |
| `bun-linux-x64`        | `linux-x64`      | glibc, AVX2                    |
| `bun-linux-arm64`      | `linux-arm64`    | glibc                          |
| `bun-linux-x64-musl`   | `linux-x64-musl` | Alpine, distroless containers  |
| `bun-linux-arm64-musl` | `linux-arm64-musl` |                              |
| `bun-linux-x64-baseline` | `linux-x64-baseline` | CPUs without AVX2        |

Bun cross-compiles all of these from a single Linux runner — the ONNX/WASM
assets are embedded at build time from `node_modules` (`onnxruntime-assets.ts`)
and the tree-sitter grammar is downloaded at runtime, so there is no
platform-native artifact anywhere in the bundle. One CI job produces every
target.

**Version source.** `CORTEX_VERSION` is read from `package.json`
(`src/version.ts`). The git tag must agree with it — Step 4 enforces this so a
mismatched release fails loudly instead of shipping a binary that reports the
wrong version to the daemon handshake.

---

## Step 1 — Teach `scripts/build.ts` to cross-compile

The build must stay on the `Bun.build` JS API: the `unavailableNativeModules`
plugin that stubs out `sharp` and `onnxruntime-node` cannot be expressed with
the `bun build --compile` CLI form.

Change the script to take a target and an output path, defaulting to the
current behavior so `bun run build` keeps working unchanged:

```ts
const target = process.env.CORTEX_TARGET; // e.g. "bun-darwin-arm64"
const outfile = process.env.CORTEX_OUTFILE ?? join(ROOT, "dist", "cortex");

const result = await Bun.build({
	entrypoints: [join(ROOT, "src", "cli", "main.ts")],
	compile: { outfile, ...(target ? { target } : {}) },
	sourcemap: "linked",
	plugins: [unavailableNativeModules],
	throw: false,
});
```

Verify the API shape once against your Bun (1.3.14):

```sh
CORTEX_TARGET=bun-darwin-arm64 CORTEX_OUTFILE=/tmp/cortex-darwin bun scripts/build.ts
file /tmp/cortex-darwin   # must report Mach-O, not ELF
```

If `compile.target` is rejected by the JS API in your version, keep the plugin
by registering it through `bunfig.toml` and fall back to
`bun build --compile --target=… src/cli/main.ts`. Confirm with
`bun build --help` before assuming either.

**Do not ship the sourcemap inside the tarball.** `sourcemap: "linked"` writes
`main.js.map` (4.5 MB) next to the binary. It is worth publishing as a separate
release asset for decoding stack traces from bug reports, but it does not
belong in the archive users download.

---

## Step 2 — A packaging script that produces the release directory

Add `scripts/package-release.ts`. It loops over the targets, compiles each into
a staging directory, archives a single `cortex` executable per target, and
writes one combined checksum file.

Asset naming — keep it mechanical, the installer parses it:

```
cortex-v0.1.0-darwin-arm64.tar.gz
cortex-v0.1.0-linux-x64.tar.gz
…
checksums.txt          # "<sha256>  <filename>" per line, sha256sum format
cortex-v0.1.0.js.map   # sourcemap, separate asset
```

Requirements for the script:

- Each tarball contains exactly one entry, `cortex`, mode `0755`. No nested
  directory — the installer extracts straight to a temp dir and moves the file.
- Use `tar -czf` via `Bun.spawn` with `--mode` normalized, so archives are
  reproducible enough to diff between runs.
- Emit `checksums.txt` in the exact `sha256sum -c` format. The installer
  verifies against it, and users can too.
- Fail on any non-zero exit; never publish a partial set.

Sanity check locally before wiring CI:

```sh
bun scripts/package-release.ts
cd dist/release && sha256sum -c checksums.txt
tar -tzf cortex-v0.1.0-linux-x64.tar.gz   # expect exactly: cortex
```

---

## Step 3 — Write `install.sh`

Lives at the repo root so the raw URL stays short and stable. Contract:

- POSIX `sh`, not bash — Alpine and Debian `/bin/sh` are not bash.
- `set -eu` at the top. No `pipefail` (not POSIX).
- Overridable by environment: `CORTEX_VERSION` (default: latest),
  `CORTEX_INSTALL_DIR` (default: `$HOME/.local/bin`).
- Never `sudo`. Install into the user's home; if the directory is not on
  `PATH`, print the exact line to add and which shell rc file to add it to.

Detection logic:

```sh
os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin) platform=darwin ;;
  Linux)  platform=linux ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
  x86_64|amd64) cpu=x64 ;;
  arm64|aarch64) cpu=arm64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

suffix="$platform-$cpu"

# musl (Alpine, distroless) needs its own build
if [ "$platform" = linux ] && ! ldd /bin/sh 2>&1 | grep -qi gnu; then
  suffix="$suffix-musl"
fi

# pre-AVX2 x64 needs the baseline build
if [ "$suffix" = linux-x64 ] && ! grep -q avx2 /proc/cpuinfo 2>/dev/null; then
  suffix=linux-x64-baseline
fi
```

The musl check reads better as "is this glibc?" than "is this musl?" — Alpine's
`ldd` prints a musl banner to stderr and exits non-zero, so a positive glibc
test is the reliable direction.

Version resolution when `CORTEX_VERSION` is unset — avoid the GitHub API
(unauthenticated rate limits bite in CI and shared networks). Follow the
`/releases/latest` redirect instead:

```sh
version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
  https://github.com/lucasreali/cortex-cli/releases/latest | sed 's|.*/tag/||')
```

Download, verify, install:

```sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

asset="cortex-$version-$suffix.tar.gz"
base="https://github.com/lucasreali/cortex-cli/releases/download/$version"

curl -fsSL "$base/$asset"        -o "$tmp/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"

expected=$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)
actual=$(sha256sum "$tmp/$asset" 2>/dev/null | cut -d' ' -f1 \
  || shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
[ "$expected" = "$actual" ] || { echo "checksum mismatch" >&2; exit 1; }

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$install_dir"
mv "$tmp/cortex" "$install_dir/cortex"
chmod +x "$install_dir/cortex"
```

Checksum verification is the whole reason to pipe a script to `sh` rather than
telling people to download a binary by hand. Do not make it optional.

**macOS quarantine.** A binary fetched by `curl` and moved into place is not
quarantined (the attribute comes from browser downloads), so unsigned builds
run fine through this path. Users who download the tarball manually from the
Releases page will hit Gatekeeper. Note the `xattr -d com.apple.quarantine`
escape hatch in the README, and treat notarization as a later step — it needs a
paid Apple Developer account and a signing job in CI.

Finish by printing what the user actually needs next:

```
cortex v0.1.0 installed to /home/you/.local/bin/cortex

  ~/.local/bin is not on your PATH. Add it:
    fish_add_path ~/.local/bin          # fish
    export PATH="$HOME/.local/bin:$PATH" # bash/zsh, add to your rc file

Next: run `cortex init` in a repository.
The first embedding downloads the model (~hundreds of MB) from HuggingFace.
```

That last line matters. The install is ~40 MB compressed, but the first
`cortex embed` pulls the Gemma model and the tree-sitter grammar. Users should
learn that at install time, not mid-session inside an agent.

---

## Step 4 — Release workflow

No `.github/` exists yet. Create `.github/workflows/release.yml`, triggered by
tags matching `v*`.

Two jobs. The first is a gate; the second only runs if it passes.

**Job `verify`** (ubuntu-latest):

1. `oven-sh/setup-bun@v2`, pinned to the same Bun as local dev (1.3.14).
2. `bun install --frozen-lockfile`
3. Assert tag and `package.json` agree — this is the check that keeps
   `CORTEX_VERSION` honest:
   ```sh
   tag="${GITHUB_REF_NAME#v}"
   pkg=$(bun -e 'console.log(require("./package.json").version)')
   [ "$tag" = "$pkg" ] || { echo "tag $tag != package.json $pkg" >&2; exit 1; }
   ```
4. `bun run typecheck`
5. `bun test`
6. `bun run smoke:compiled` — the real gate. It builds the binary and drives
   init, index, MCP `save_decision`, a live embed through the self-spawned
   worker, and semantic search. Note it needs network for the grammar download
   and the model, and `git` for the fixture repo.

**Job `release`** (ubuntu-latest, `needs: verify`):

1. Same setup and install steps.
2. `bun scripts/package-release.ts` — all targets, one job.
3. `gh release create "$GITHUB_REF_NAME" dist/release/* --generate-notes`,
   using the built-in `GITHUB_TOKEN` with `permissions: contents: write`.

Cross-compiled artifacts are built but not executed in CI. Add a third job on
`macos-latest` that downloads its own `darwin-arm64` asset and runs
`cortex --version` plus `cortex init --yes` in a temp repo if you want darwin
covered automatically; otherwise verify the first release on a Mac by hand and
keep it a manual checklist item.

---

## Step 5 — Cut `v0.1.0` and verify end to end

```sh
git tag v0.1.0
git push origin v0.1.0
```

Then check, on a machine that has never run cortex:

- [ ] `curl -fsSL …/install.sh | sh` succeeds and prints the PATH hint.
- [ ] `cortex --version` prints `0.1.0`.
- [ ] `cortex init` + `cortex index` work in a fresh repo (grammar downloads to
      `~/.cortex/grammars`, sha256 verified).
- [ ] `cortex embed --missing` downloads the model and completes.
- [ ] `cortex search "<something in Portuguese>"` returns a semantic hit.
- [ ] `cortex doctor` is clean.
- [ ] `CORTEX_VERSION=v0.1.0 curl … | sh` pins correctly.
- [ ] Re-running the installer over an existing install overwrites cleanly.
- [ ] A tampered `checksums.txt` makes the installer abort.

---

## Step 6 — README install section

Replace whatever install instructions exist with the one-liner, plus:

- the manual download alternative (Releases page + `sha256sum -c`), for people
  who will not pipe a URL into a shell — a reasonable position, give them the
  path;
- the MCP client config snippet, using the absolute path
  `~/.local/bin/cortex serve --mcp`;
- the first-run model download expectation;
- uninstall: `rm ~/.local/bin/cortex`, and `rm -rf ~/.cortex` to also drop the
  grammar cache and daemon state — call out that per-project `.cortex/`
  directories hold the decisions and are not touched.

---

## Step 7 — `cortex upgrade`

The command is `install.sh` re-expressed in TypeScript against the binary that
is currently running, and it must never be weaker than the shell path: the
sha256 line for the asset is verified before anything is unpacked.

- `src/release/target.ts` — which asset this binary is. The suffix is baked at
  compile time (`scripts/compile.ts` passes `define` to `Bun.build`,
  `package-release.ts` knows the suffix per target) because a binary cannot
  tell from the inside which libc it was linked against or whether it was
  built for a baseline CPU. A locally built binary has nothing baked and falls
  back to describing its host.
- `src/release/catalog.ts` — resolves the tag by following the
  `/releases/latest` redirect, exactly as `latest_version()` does, so the
  upgrade path needs no token and never meets the GitHub API rate limit. Then
  downloads the asset and `checksums.txt` and verifies the digest.
- `src/release/archive.ts` — gunzip plus a ustar reader for the single member
  named `cortex`. Reading it in-process rather than shelling out to `tar`
  keeps the binary's "no runtime dependencies" promise, and it can only ever
  extract that one member, so a hostile archive cannot write anywhere else.
- `src/release/installer.ts` — the replacement. The running executable cannot
  be written into (`ETXTBSY`), so the new binary is staged next to the target
  (same filesystem, therefore an atomic rename), chmodded, and made to prove
  it runs by answering `--version` *before* the old one is given up. A wrong
  architecture surfaces here as a `posix_spawn` failure, with the working
  binary still in place.

`--version` accepts a downgrade; the explicit flag is the consent. `--check`
never writes and works from a source checkout, which is what lets the CLI
tests exercise version resolution without a compiled binary.

## Upgrades and the daemon

Worth knowing, because it looks like a bug and is not: the daemon socket is
keyed by model id, not by version (`daemon/paths.ts`), so a freshly installed
binary can find a daemon from the previous version still listening. The
handshake handles it — `daemon/client.ts:108` rejects a hello whose version
does not match — but a rejected probe deliberately does not spawn a
replacement, so every session would degrade to a private worker until the old
daemon's idle timeout expired.

`cortex upgrade` therefore ends that state on purpose: after a successful
replacement it reads the daemon lock and sends `SIGTERM`
(`embedding/daemon/stop.ts`), and the next session spawns a daemon on the new
version. Killing it is safe because of the ladder — an in-flight request
falls back to a private worker, and the query path's timeouts guarantee FTS
answers regardless.

What users still need to know is that an MCP server already running inside
their editor keeps the old binary in memory until the client restarts it.

---

## Later, on top of the same artifacts

1. **Homebrew tap** — `lucasreali/homebrew-tap`, a formula pointing at the
   darwin/linux tarballs with their checksums. Near-free once Step 2 exists.
2. **npm wrapper** — thin root package plus per-platform
   `optionalDependencies` carrying the same binaries. Requires dropping
   `private: true` and confirming the name on npm; `cortex-cli` may be taken,
   in which case scope it (`@lucasreali/cortex`) and keep the command `cortex`.
3. **Windows** — packaging is one more Bun target; the actual work is the Unix
   socket in the shared daemon.
4. **Notarization** — signed and notarized macOS builds, if manual downloads
   from the Releases page become a common path.
