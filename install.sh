#!/bin/sh
set -eu

REPO="lucasreali/cortex-cli"
INSTALL_DIR="${CORTEX_INSTALL_DIR:-$HOME/.local/bin}"

die() {
	echo "cortex: $1" >&2
	exit 1
}

require() {
	command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"
}

detect_platform() {
	case "$(uname -s)" in
	Darwin) echo darwin ;;
	Linux) echo linux ;;
	*) die "unsupported OS: $(uname -s) (macOS and Linux only)" ;;
	esac
}

detect_cpu() {
	case "$(uname -m)" in
	x86_64 | amd64) echo x64 ;;
	arm64 | aarch64) echo arm64 ;;
	*) die "unsupported architecture: $(uname -m)" ;;
	esac
}

is_musl() {
	if ldd --version 2>&1 | grep -qi musl; then
		return 0
	fi
	[ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]
}

has_avx2() {
	grep -q avx2 /proc/cpuinfo 2>/dev/null
}

# src/release/target.ts resolves the same suffix for `cortex upgrade`, from a
# value baked in at build time. Changing the rule here without changing it
# there splits install from upgrade.
detect_suffix() {
	platform=$(detect_platform)
	cpu=$(detect_cpu)
	suffix="$platform-$cpu"
	if [ "$platform" != linux ]; then
		echo "$suffix"
		return 0
	fi
	if is_musl; then
		echo "$suffix-musl"
		return 0
	fi
	if [ "$suffix" = linux-x64 ] && ! has_avx2; then
		echo linux-x64-baseline
		return 0
	fi
	echo "$suffix"
}

latest_version() {
	url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
		"https://github.com/$REPO/releases/latest")
	case "$url" in
	*/releases/tag/*) echo "${url##*/tag/}" ;;
	*) die "no published release found at https://github.com/$REPO/releases" ;;
	esac
}

resolve_version() {
	if [ -z "${CORTEX_VERSION:-}" ]; then
		latest_version
		return 0
	fi
	case "$CORTEX_VERSION" in
	v*) echo "$CORTEX_VERSION" ;;
	*) echo "v$CORTEX_VERSION" ;;
	esac
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
		return 0
	fi
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
		return 0
	fi
	die "neither sha256sum nor shasum is available; cannot verify the download"
}

verify() {
	expected=$(awk -v name="$2" '$2 == name { print $1 }' "$3")
	[ -n "$expected" ] || die "$2 is not listed in checksums.txt"
	actual=$(sha256_of "$1")
	[ "$expected" = "$actual" ] || die "checksum mismatch for $2
  expected $expected
  actual   $actual"
}

path_hint() {
	case ":${PATH:-}:" in
	*":$INSTALL_DIR:"*) return 0 ;;
	esac
	cat <<EOF

  $INSTALL_DIR is not on your PATH. Add it:
    fish_add_path $INSTALL_DIR                 # fish
    export PATH="$INSTALL_DIR:\$PATH"          # bash/zsh, add to your rc file
EOF
}

require curl
require tar

suffix=$(detect_suffix)
version=$(resolve_version)
asset="cortex-$version-$suffix.tar.gz"
base="https://github.com/$REPO/releases/download/$version"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "cortex: downloading $asset"
curl -fsSL "$base/$asset" -o "$tmp/$asset" ||
	die "failed to download $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" ||
	die "failed to download $base/checksums.txt"

verify "$tmp/$asset" "$asset" "$tmp/checksums.txt"

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/cortex" ] || die "$asset did not contain a cortex executable"

mkdir -p "$INSTALL_DIR"
mv -f "$tmp/cortex" "$INSTALL_DIR/cortex"
chmod 755 "$INSTALL_DIR/cortex"

echo "cortex $version installed to $INSTALL_DIR/cortex"
path_hint
cat <<EOF

Next: run \`cortex init\` in a repository.
The first embedding downloads the model (~hundreds of MB) from HuggingFace.
Later: \`cortex upgrade\` replaces this binary in place.
EOF
