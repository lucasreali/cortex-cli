import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTarball } from "@tests/release/tarball";
import { buildTarget } from "@/release/target";
import { sha256Hex } from "@/support/hash";
import { CORTEX_VERSION } from "@/version";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const TAG = "v9.9.9";
const TARBALL = makeTarball([
	{ name: "cortex", bytes: new TextEncoder().encode("compiled-cortex") },
]);

let server: ReturnType<typeof Bun.serve>;
let published: boolean;
let latestHits: number;

// Spawned asynchronously on purpose: the release server these commands talk to
// runs on this process's event loop, and spawnSync would block it until the
// child gave up waiting for a response that could never arrive.
async function cli(...args: string[]): Promise<{
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
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code: (await child.exited) ?? 1, stdout, stderr };
}

beforeEach(() => {
	published = true;
	latestHits = 0;
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/releases/latest") {
				latestHits++;
				if (!published) return new Response("gone", { status: 404 });
				return new Response(null, {
					status: 302,
					headers: { location: `https://host/releases/tag/${TAG}` },
				});
			}
			if (path.endsWith("/checksums.txt")) {
				return new Response(
					`${sha256Hex(TARBALL)}  ${path.split("/").pop()}\n`,
				);
			}
			return new Response(TARBALL);
		},
	});
});

afterEach(() => {
	server.stop(true);
});

describe("cortex upgrade", () => {
	test("--check --json reports the published release without writing anything", async () => {
		const result = await cli("upgrade", "--check", "--json");
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			current: CORTEX_VERSION,
			latest: "9.9.9",
			target: buildTarget(),
			upToDate: false,
		});
	});

	test("--check names the version to move to", async () => {
		const result = await cli("upgrade", "--check");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`${CORTEX_VERSION} → 9.9.9 available`);
	});

	// A pinned version is the answer, so asking GitHub for the latest one would
	// be a pointless round trip.
	test("--check --version compares against the pin without resolving latest", async () => {
		const result = await cli(
			"upgrade",
			"--check",
			"--json",
			"--version",
			"0.0.1",
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).upToDate).toBe(true);
		expect(latestHits).toBe(0);
	});

	test("refuses to replace anything when running from a source checkout", async () => {
		const result = await cli("upgrade");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("source checkout");
	});

	test("rejects --json outside a check", async () => {
		const result = await cli("upgrade", "--json");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("usage: cortex upgrade");
	});

	test("reports a repository with no published release", async () => {
		published = false;
		const result = await cli("upgrade", "--check");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no published release found");
	});

	test("is listed in the help, and update is not a command", async () => {
		expect((await cli("--help")).stdout).toContain("upgrade [--check]");
		const unknown = await cli("update");
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("unknown command: update");
	});
});
