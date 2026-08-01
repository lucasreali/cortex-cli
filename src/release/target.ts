import { existsSync } from "node:fs";

const DEFAULT_ORIGIN = "https://github.com/lucasreali/cortex-cli";

export interface Host {
	platform: string;
	cpu: string;
	musl: boolean;
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

export function currentHost(): Host {
	return {
		platform: process.platform,
		cpu: process.arch,
		musl:
			existsSync("/lib/ld-musl-x86_64.so.1") ||
			existsSync("/lib/ld-musl-aarch64.so.1"),
	};
}

export function targetForHost(host: Host): string {
	const cpu = supportedCpu(host.cpu);
	if (host.platform === "darwin") return `darwin-${cpu}`;
	if (host.platform !== "linux") {
		throw new Error(`unsupported platform: ${host.platform}`);
	}
	return host.musl ? `linux-${cpu}-musl` : `linux-${cpu}`;
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

function supportedCpu(cpu: string): string {
	if (cpu === "x64" || cpu === "arm64") return cpu;
	throw new Error(`unsupported architecture: ${cpu}`);
}
