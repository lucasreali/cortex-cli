import { afterEach, describe, expect, test } from "bun:test";
import {
	assetName,
	assetUrl,
	buildTarget,
	checksumsUrl,
	currentHost,
	type Host,
	normalizeTag,
	releaseOrigin,
	targetForHost,
	versionFromTag,
} from "@/release/target";

const KNOWN_TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
];

const originalOrigin = process.env.CORTEX_RELEASE_BASE_URL;
const originalTarget = process.env.CORTEX_BUILD_TARGET;

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	restore("CORTEX_RELEASE_BASE_URL", originalOrigin);
	restore("CORTEX_BUILD_TARGET", originalTarget);
});

function host(overrides: Partial<Host> = {}): Host {
	return { platform: "linux", cpu: "x64", musl: false, ...overrides };
}

describe("targetForHost", () => {
	test("maps every supported platform and cpu", () => {
		expect(targetForHost(host({ platform: "darwin", cpu: "arm64" }))).toBe(
			"darwin-arm64",
		);
		expect(targetForHost(host({ platform: "darwin", cpu: "x64" }))).toBe(
			"darwin-x64",
		);
		expect(targetForHost(host())).toBe("linux-x64");
		expect(targetForHost(host({ cpu: "arm64" }))).toBe("linux-arm64");
	});

	test("musl hosts get the musl asset", () => {
		expect(targetForHost(host({ musl: true }))).toBe("linux-x64-musl");
		expect(targetForHost(host({ cpu: "arm64", musl: true }))).toBe(
			"linux-arm64-musl",
		);
	});

	// musl only matters on linux, so darwin must not be reachable through it.
	test("darwin ignores the musl probe", () => {
		expect(targetForHost(host({ platform: "darwin", musl: true }))).toBe(
			"darwin-x64",
		);
	});

	test("rejects platforms and architectures with no published asset", () => {
		expect(() => targetForHost(host({ platform: "win32" }))).toThrow(
			"unsupported platform: win32",
		);
		expect(() => targetForHost(host({ cpu: "ia32" }))).toThrow(
			"unsupported architecture: ia32",
		);
	});
});

describe("currentHost", () => {
	test("describes the running machine", () => {
		const probe = currentHost();
		expect(probe.platform).toBe(process.platform);
		expect(probe.cpu).toBe(process.arch);
		expect(typeof probe.musl).toBe("boolean");
	});
});

describe("buildTarget", () => {
	test("prefers the suffix baked in at compile time", () => {
		process.env.CORTEX_BUILD_TARGET = "linux-x64-baseline";
		expect(buildTarget()).toBe("linux-x64-baseline");
	});

	test("falls back to describing the host when nothing was baked", () => {
		delete process.env.CORTEX_BUILD_TARGET;
		expect(KNOWN_TARGETS).toContain(buildTarget());
	});
});

describe("release addresses", () => {
	test("normalizes a version into a tag either way round", () => {
		expect(normalizeTag("0.2.0")).toBe("v0.2.0");
		expect(normalizeTag("v0.2.0")).toBe("v0.2.0");
		expect(versionFromTag("v0.2.0")).toBe("0.2.0");
		expect(versionFromTag("0.2.0")).toBe("0.2.0");
	});

	test("builds the asset name and urls the release workflow publishes", () => {
		expect(assetName("v0.2.0", "linux-x64")).toBe(
			"cortex-v0.2.0-linux-x64.tar.gz",
		);
		expect(assetUrl("https://host/repo", "v0.2.0", "asset.tar.gz")).toBe(
			"https://host/repo/releases/download/v0.2.0/asset.tar.gz",
		);
		expect(checksumsUrl("https://host/repo", "v0.2.0")).toBe(
			"https://host/repo/releases/download/v0.2.0/checksums.txt",
		);
	});

	test("the origin defaults to the project repository and honors the override", () => {
		delete process.env.CORTEX_RELEASE_BASE_URL;
		expect(releaseOrigin()).toBe("https://github.com/lucasreali/cortex-cli");
		process.env.CORTEX_RELEASE_BASE_URL = "http://localhost:1234";
		expect(releaseOrigin()).toBe("http://localhost:1234");
	});
});
