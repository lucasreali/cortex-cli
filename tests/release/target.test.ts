import { afterEach, describe, expect, test } from "bun:test";
import {
	assetName,
	assetUrl,
	buildTarget,
	checksumsUrl,
	currentHost,
	type Host,
	normalizeTag,
	RELEASE_SUFFIXES,
	releaseOrigin,
	targetForHost,
	versionFromTag,
} from "@/release/target";

const KNOWN_TARGETS: readonly string[] = RELEASE_SUFFIXES;

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
	return {
		platform: "linux",
		cpu: "x64",
		musl: false,
		baseline: false,
		...overrides,
	};
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

	// install.sh's detect_suffix emits linux-x64-baseline; targetForHost has to
	// be able to reach it or install and upgrade disagree on non-AVX2 hosts.
	test("a linux x64 host without avx2 gets the baseline asset", () => {
		expect(targetForHost(host({ baseline: true }))).toBe("linux-x64-baseline");
		expect(targetForHost(host({ cpu: "arm64", baseline: true }))).toBe(
			"linux-arm64",
		);
		expect(targetForHost(host({ baseline: true, musl: true }))).toBe(
			"linux-x64-musl",
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
		expect(typeof probe.baseline).toBe("boolean");
	});

	// `grep -q avx2 /proc/cpuinfo` exits non-zero when the file is not there, so
	// install.sh sends a host it cannot inspect the baseline build. This has to
	// answer the same way, and it is the answer that runs on either CPU.
	test("an unreadable cpuinfo asks for the baseline build, as install.sh does", () => {
		expect(currentHost("/definitely/not/a/cpuinfo").baseline).toBe(
			process.platform === "linux",
		);
	});

	// install.sh reads a failed `ldd --version` as "not musl" and carries on;
	// spawnSync answers a missing executable by throwing.
	test("a host with no ldd at all is described rather than fatal", () => {
		const path = process.env.PATH;
		process.env.PATH = "/definitely/not/a/bin";
		try {
			expect(currentHost().musl).toBe(false);
		} finally {
			restore("PATH", path);
		}
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

	test("rejects a version that is not one a release could be named", () => {
		expect(() => normalizeTag("../../etc/passwd")).toThrow(
			"not a release version",
		);
		expect(() => normalizeTag("0.2.0/../..")).toThrow("not a release version");
		expect(() => normalizeTag("")).toThrow("not a release version");
		expect(normalizeTag("1.0.0-rc.1+build.2")).toBe("v1.0.0-rc.1+build.2");
	});
});

describe("releaseOrigin", () => {
	test("defaults to the project repository", () => {
		delete process.env.CORTEX_RELEASE_BASE_URL;
		expect(releaseOrigin()).toBe("https://github.com/lucasreali/cortex-cli");
		expect(releaseOrigin(true)).toBe(
			"https://github.com/lucasreali/cortex-cli",
		);
	});

	// A source checkout cannot install anything — runUpgrade refuses — which is
	// what lets the tests point the whole flow at a local server.
	test("a source checkout honors the override", () => {
		process.env.CORTEX_RELEASE_BASE_URL = "http://localhost:1234";
		expect(releaseOrigin(false)).toBe("http://localhost:1234");
	});

	// Whatever this names is downloaded, run once for a version probe and then
	// renamed over the running binary. An installed cortex takes it only for an
	// address GitHub itself serves.
	test("an installed binary refuses an origin GitHub does not serve", () => {
		for (const override of [
			"http://localhost:1234",
			"http://github.com",
			"https://github.com.attacker.tld",
			"https://raw.githubusercontent.com",
			"https://github.com:8443",
			"file:///tmp/payload",
			"not a url at all",
		]) {
			process.env.CORTEX_RELEASE_BASE_URL = override;
			expect(() => releaseOrigin(true)).toThrow("refusing to upgrade from");
		}
	});

	test("an installed binary takes an https github.com origin", () => {
		process.env.CORTEX_RELEASE_BASE_URL = "https://github.com/someone/fork";
		expect(releaseOrigin(true)).toBe("https://github.com/someone/fork");
	});

	test("an empty override is no override", () => {
		process.env.CORTEX_RELEASE_BASE_URL = "";
		expect(releaseOrigin(true)).toBe(
			"https://github.com/lucasreali/cortex-cli",
		);
	});
});
