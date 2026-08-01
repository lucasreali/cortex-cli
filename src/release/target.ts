import { existsSync, readFileSync } from "node:fs";

const DEFAULT_ORIGIN = "https://github.com/lucasreali/cortex-cli";
const CPUINFO_PATH = "/proc/cpuinfo";

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
] as const;

export interface Host {
	platform: string;
	cpu: string;
	musl: boolean;
	baseline: boolean;
}

export function releaseOrigin(): string {
	return process.env.CORTEX_RELEASE_BASE_URL ?? DEFAULT_ORIGIN;
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
	if (host.platform !== "linux") {
		throw new Error(`unsupported platform: ${host.platform}`);
	}
	if (host.musl) return `linux-${cpu}-musl`;
	if (host.baseline && cpu === "x64") return "linux-x64-baseline";
	return `linux-${cpu}`;
}

export function normalizeTag(version: string): string {
	return version.startsWith("v") ? version : `v${version}`;
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
// answering on stderr is normal, so both streams are inspected.
function runsOnMusl(): boolean {
	if (existsSync("/lib/ld-musl-x86_64.so.1")) return true;
	if (existsSync("/lib/ld-musl-aarch64.so.1")) return true;
	const probe = Bun.spawnSync(["ldd", "--version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const reported = `${probe.stdout}${probe.stderr}`;
	return reported.toLowerCase().includes("musl");
}

// A CPU without AVX2 needs the baseline build; assuming AVX2 when /proc is
// unreadable matches install.sh, which treats a missing cpuinfo the same way.
function supportsAvx2(cpuinfoPath: string): boolean {
	if (!existsSync(cpuinfoPath)) return true;
	return readFileSync(cpuinfoPath, "utf8").includes("avx2");
}

function supportedCpu(cpu: string): string {
	if (cpu === "x64" || cpu === "arm64") return cpu;
	throw new Error(`unsupported architecture: ${cpu}`);
}
