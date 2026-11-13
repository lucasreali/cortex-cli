import { existsSync, readFileSync } from "node:fs";
import { RUNS_FROM_COMPILED_BINARY } from "@/support/platform";

export const RELEASE_REPOSITORY = "lucasreali/cortex-cli";
const DEFAULT_ORIGIN = `https://github.com/${RELEASE_REPOSITORY}`;
const ATTESTATIONS_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/attestations`;
const CPUINFO_PATH = "/proc/cpuinfo";

// A tag reaches a download URL, so it may only be what a release is actually
// named: no path segment of its own, no scheme, nothing to escape the address
// the origin allowlist just pinned.
const TAG_PATTERN = /^v[0-9A-Za-z][0-9A-Za-z.+-]*$/;

// Every asset the release workflow publishes. scripts/package-release.ts
// compiles one binary per entry (Bun's target is this prefixed with "bun-"),
// and targetForHost picks from the same list, so a suffix cannot exist on one
// side only.
export const RELEASE_SUFFIXES = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
	"linux-x64-baseline",
	"windows-x64",
] as const;

export interface Host {
	platform: string;
	cpu: string;
	musl: boolean;
	baseline: boolean;
}

// CORTEX_RELEASE_BASE_URL is a test seam, not a setting. Whatever it names is
// downloaded, executed once for a version probe and then renamed over the
// running binary, so anything able to set an environment variable — a cloned
// repo's .envrc, an MCP server's env block, a CI job — would own every later
// cortex and every agent session that spawns it. An installed binary therefore
// takes the override only when it names this project's own repository — any
// other path on github.com is a fork anyone can publish a release into, with a
// checksums.txt of their own. A source checkout, which runUpgrade refuses to
// install from at all, is where the tests point it at a local server.
export function releaseOrigin(
	compiled: boolean = RUNS_FROM_COMPILED_BINARY,
): string {
	const override = process.env.CORTEX_RELEASE_BASE_URL;
	if (!override) return DEFAULT_ORIGIN;
	if (!compiled) return override;
	return trustedOrigin(override);
}

function trustedOrigin(override: string): string {
	if (override.replace(/\/+$/, "") === DEFAULT_ORIGIN) return DEFAULT_ORIGIN;
	throw new Error(
		`refusing to upgrade from ${override}: an installed cortex only ` +
			`upgrades from ${DEFAULT_ORIGIN}`,
	);
}

// Where the build-provenance attestations for an origin's assets are listed.
// Only the real origin has them; the source-checkout seam serves its own.
export function attestationsEndpoint(origin: string): string {
	return origin === DEFAULT_ORIGIN
		? ATTESTATIONS_API
		: `${origin}/attestations`;
}

// scripts/compile.ts bakes this in per cross-compiled target: a binary cannot
// tell from the inside which libc it was linked against, and a baseline build
// is indistinguishable from a plain one. Only a locally built binary falls
// back to describing its host, and installBinary's smoke run catches a wrong
// guess before anything is replaced.
export function buildTarget(): string {
	return process.env.CORTEX_BUILD_TARGET ?? targetForHost(currentHost());
}

export function currentHost(cpuinfoPath: string = CPUINFO_PATH): Host {
	const linux = process.platform === "linux";
	return {
		platform: process.platform,
		cpu: process.arch,
		musl: linux && runsOnMusl(),
		baseline: linux && !supportsAvx2(cpuinfoPath),
	};
}

export function targetForHost(host: Host): string {
	const cpu = supportedCpu(host.cpu);
	if (host.platform === "darwin") return `darwin-${cpu}`;
	// Bun cross-compiles no windows-arm64, and Windows on ARM runs an x64
	// binary under emulation, so both architectures resolve to the one asset —
	// which is also what install.ps1 answers, and the two may not disagree.
	if (host.platform === "win32") return "windows-x64";
	if (host.platform !== "linux") {
		throw new Error(`unsupported platform: ${host.platform}`);
	}
	if (host.musl) return `linux-${cpu}-musl`;
	if (host.baseline && cpu === "x64") return "linux-x64-baseline";
	return `linux-${cpu}`;
}

export function normalizeTag(version: string): string {
	const tag = version.startsWith("v") ? version : `v${version}`;
	if (TAG_PATTERN.test(tag)) return tag;
	throw new Error(`not a release version: ${version}`);
}

export function versionFromTag(tag: string): string {
	return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function assetName(tag: string, target: string): string {
	return `cortex-${tag}-${target}.tar.gz`;
}

export function assetUrl(origin: string, tag: string, asset: string): string {
	return `${origin}/releases/download/${tag}/${asset}`;
}

export function checksumsUrl(origin: string, tag: string): string {
	return `${origin}/releases/download/${tag}/checksums.txt`;
}

// install.sh reads `ldd --version` as well as the loader paths; a glibc host
// answering on stderr is normal, so both streams are inspected. A host with no
// ldd at all is not a musl host as far as either side can tell — the shell
// reads the failed command as "no", and spawnSync must not throw where it
// degrades.
function runsOnMusl(): boolean {
	if (existsSync("/lib/ld-musl-x86_64.so.1")) return true;
	if (existsSync("/lib/ld-musl-aarch64.so.1")) return true;
	return reportedLdd().toLowerCase().includes("musl");
}

function reportedLdd(): string {
	try {
		const probe = Bun.spawnSync(["ldd", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
			// ldd is found through PATH, and a subprocess otherwise inherits the
			// environment this process started with rather than the one it has
			// now: handing it the search path is what a probe needs, and all it
			// needs.
			env: { PATH: process.env.PATH ?? "" },
		});
		return `${probe.stdout}${probe.stderr}`;
	} catch {
		return "";
	}
}

// A CPU without AVX2 needs the baseline build, and install.sh answers a
// cpuinfo it cannot read the same way this does: `grep -q avx2 /proc/cpuinfo`
// exits non-zero when the file is absent. Agreeing on the baseline build is
// also agreeing on the safe answer — it runs on either CPU, where the AVX2
// build meets a machine without AVX2 as an illegal instruction.
function supportsAvx2(cpuinfoPath: string): boolean {
	try {
		return readFileSync(cpuinfoPath, "utf8").includes("avx2");
	} catch {
		return false;
	}
}

function supportedCpu(cpu: string): string {
	if (cpu === "x64" || cpu === "arm64") return cpu;
	throw new Error(`unsupported architecture: ${cpu}`);
}
