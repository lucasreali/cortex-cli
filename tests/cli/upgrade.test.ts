import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTarball } from "@tests/release/tarball";
import { daemonPathsFor } from "@/embedding/daemon/paths";
import { GEMMA_MODEL } from "@/embedding/model";
import { assetName, buildTarget, versionFromTag } from "@/release/target";
import { sha256Hex } from "@/support/hash";
import { CORTEX_VERSION } from "@/version";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const TAG = "v9.9.9";

// What the release serves is a runnable script rather than an opaque blob:
// installBinary probes the unpacked member for its version before giving up the
// file it replaces, so a payload that cannot run proves nothing about the order
// the command does its work in.
function cortexReporting(version: string): string {
	return `#!/bin/sh\necho ${version}\n`;
}

const PREVIOUS_BINARY = cortexReporting("1.0.0");

let server: ReturnType<typeof Bun.serve>;
let publishedTag: string | null;
let releasedVersion: string | null;
let corruptChecksum: boolean;
let latestHits: number;

function releasedBinary(): string {
	return cortexReporting(
		releasedVersion ?? versionFromTag(publishedTag ?? TAG),
	);
}

// checksums.txt is fetched from /releases/download/<tag>/, and it names the
// asset beside it — the file the command is about to verify, not itself.
function requestedAsset(path: string): string {
	const tag = path.split("/").at(-2) ?? TAG;
	return assetName(tag, buildTarget());
}

function tarball(): Uint8Array<ArrayBuffer> {
	return makeTarball([
		{ name: "cortex", bytes: new TextEncoder().encode(releasedBinary()) },
	]);
}

// Spawned asynchronously on purpose: the release server these commands talk to
// runs on this process's event loop, and spawnSync would block it until the
// child gave up waiting for a response that could never arrive.
async function cli(
	args: string[],
	extraEnvironment: Record<string, string> = {},
): Promise<{
	code: number;
	stdout: string;
	stderr: string;
}> {
	const child = Bun.spawn(["bun", MAIN_PATH, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			CORTEX_RELEASE_BASE_URL: `http://localhost:${server.port}`,
			...extraEnvironment,
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code: (await child.exited) ?? 1, stdout, stderr };
}

beforeEach(() => {
	publishedTag = TAG;
	releasedVersion = null;
	corruptChecksum = false;
	latestHits = 0;
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/releases/latest") {
				latestHits++;
				if (!publishedTag) return new Response("gone", { status: 404 });
				return new Response(null, {
					status: 302,
					headers: { location: `/releases/tag/${publishedTag}` },
				});
			}
			if (path.endsWith("/checksums.txt")) {
				const digest = corruptChecksum ? "0".repeat(64) : sha256Hex(tarball());
				return new Response(`${digest}  ${requestedAsset(path)}\n`);
			}
			return new Response(tarball());
		},
	});
});

afterEach(() => {
	server.stop(true);
});

describe("cortex upgrade", () => {
	test("--check --json reports the published release without writing anything", async () => {
		const result = await cli(["upgrade", "--check", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			current: CORTEX_VERSION,
			latest: "9.9.9",
			target: buildTarget(),
			upToDate: false,
		});
	});

	test("--check names the version to move to", async () => {
		const result = await cli(["upgrade", "--check"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`${CORTEX_VERSION} → 9.9.9 available`);
	});

	test("--check says so when the published release is the running one", async () => {
		publishedTag = `v${CORTEX_VERSION}`;
		const result = await cli(["upgrade", "--check"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`cortex ${CORTEX_VERSION} is up to date`);
	});

	// A pinned version is the answer, so asking GitHub for the latest one would
	// be a pointless round trip.
	test("--check --version compares against the pin without resolving latest", async () => {
		const result = await cli([
			"upgrade",
			"--check",
			"--json",
			"--version",
			"0.0.1",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).upToDate).toBe(true);
		expect(latestHits).toBe(0);
	});

	test("refuses to replace anything when running from a source checkout", async () => {
		const result = await cli(["upgrade"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("source checkout");
	});

	test("rejects --json outside a check", async () => {
		const result = await cli(["upgrade", "--json"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("usage: cortex upgrade");
	});

	test("reports a repository with no published release", async () => {
		publishedTag = null;
		const result = await cli(["upgrade", "--check"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no published release found");
	});

	test("is listed in the help, and update is not a command", async () => {
		expect((await cli(["--help"])).stdout).toContain(
			"upgrade [--check [--json]] [--version V] [--force]",
		);
		const unknown = await cli(["update"]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("unknown command: update");
	});
});

// H18: every test above runs the CLI from source, where the command
// short-circuits on "this is not an installed binary" before touching any of
// the orchestration. The primitives underneath it are covered — installer.test.ts
// owns the rename, catalog.test.ts owns the checksum — and the order they run in
// was covered by nothing at all: a success message printed before a failed
// rename, or the tarball handed to installBinary instead of its unpacked member,
// would ship green. CORTEX_UPGRADE_TARGET_PATH gives the source checkout a file
// of its own to install over, which is what makes that order observable.
describe("cortex upgrade installs", () => {
	let root: string;
	let installed: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-upgrade-")));
		installed = join(root, "cortex");
		writeFileSync(installed, PREVIOUS_BINARY, { mode: 0o755 });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function upgrade(...args: string[]) {
		return cli(["upgrade", ...args], {
			CORTEX_UPGRADE_TARGET_PATH: installed,
			CORTEX_DAEMON_DIR: join(root, "daemon"),
		});
	}

	function installedBinary(): string {
		return readFileSync(installed, "utf8");
	}

	function reportedVersion(): string {
		return Bun.spawnSync([installed, "--version"], { stdout: "pipe" })
			.stdout.toString()
			.trim();
	}

	test("downloads, unpacks, probes and renames over the target", async () => {
		const result = await upgrade();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`Downloading cortex-${TAG}-${buildTarget()}.tar.gz from http://localhost:`,
		);
		expect(result.stdout).toContain(`cortex ${TAG} installed to `);
		expect(installedBinary()).toBe(cortexReporting("9.9.9"));
		expect(reportedVersion()).toBe("9.9.9");
		// The staging file is named after the target, so an orphan left behind
		// would be sitting right next to it.
		expect(readdirSync(root)).toEqual(["cortex"]);
	}, 20_000);

	test("says the binary is current, and leaves it alone, when it is", async () => {
		publishedTag = `v${CORTEX_VERSION}`;
		const result = await upgrade();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`cortex ${CORTEX_VERSION} is already the latest release`,
		);
		expect(installedBinary()).toBe(PREVIOUS_BINARY);
	});

	// --force and --version are the two ways to ask for a release that is not
	// newer, and both have to reach the download rather than the early return.
	test("--force reinstalls the release it is already on", async () => {
		publishedTag = `v${CORTEX_VERSION}`;
		const result = await upgrade("--force");

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`cortex v${CORTEX_VERSION} installed to `);
		expect(reportedVersion()).toBe(CORTEX_VERSION);
	}, 20_000);

	test("--version installs the pinned tag without resolving latest", async () => {
		const result = await upgrade("--version", "9.9.9");

		expect(result.code).toBe(0);
		expect(latestHits).toBe(0);
		expect(reportedVersion()).toBe("9.9.9");
	}, 20_000);

	// The whole point of the probe: what is served reports another version, so
	// the check has to refuse it and the installed binary has to survive.
	test("a download that reports another version replaces nothing", async () => {
		releasedVersion = "0.0.1";
		const result = await upgrade();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not run here");
		expect(result.stdout).not.toContain("installed to");
		expect(installedBinary()).toBe(PREVIOUS_BINARY);
		expect(readdirSync(root).sort()).toEqual(["cortex"]);
	}, 20_000);

	test("a checksum mismatch replaces nothing", async () => {
		corruptChecksum = true;
		const result = await upgrade();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("checksum mismatch");
		expect(result.stdout).not.toContain("installed to");
		expect(installedBinary()).toBe(PREVIOUS_BINARY);
	}, 20_000);

	// The socket is keyed by model rather than by version, so a daemon left by
	// the replaced binary would keep answering and keep being rejected by the
	// handshake. Nothing else in the suite reaches announceDaemon.
	test("stops the daemon the replaced binary left running", async () => {
		const daemon = Bun.spawn(["sleep", "60"], { stdout: "ignore" });
		const paths = daemonPathsFor(GEMMA_MODEL.modelId, join(root, "daemon"));
		mkdirSync(paths.directory, { recursive: true });
		writeFileSync(
			paths.lockPath,
			JSON.stringify({
				pid: daemon.pid,
				version: CORTEX_VERSION,
				modelId: GEMMA_MODEL.modelId,
				socketPath: paths.socketPath,
				startedAt: Date.now(),
			}),
		);

		const result = await upgrade();

		expect(result.stdout).toContain(
			"Stopped the embedding daemon from the old version",
		);
		expect(await daemon.exited).not.toBe(0);
	}, 20_000);

	test("says nothing about a daemon that was not running", async () => {
		const result = await upgrade();
		expect(result.stdout).not.toContain("Stopped the embedding daemon");
	}, 20_000);
});
