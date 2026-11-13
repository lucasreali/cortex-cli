import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { downloadRelease, latestTag } from "@/release/catalog";
import { assetName } from "@/release/target";
import { sha256Hex } from "@/support/hash";
import { makeTarball } from "./tarball";

const TAG = "v9.9.9";
const TARGET = "linux-x64";
const ASSET = assetName(TAG, TARGET);
const TARBALL = makeTarball([
	{ name: "cortex", bytes: new TextEncoder().encode("compiled-cortex") },
]);

interface Release {
	location: string | null;
	checksums: string | null;
	tarball: Uint8Array | null;
	attestations: string | null;
}

function provenance(overrides: Record<string, unknown> = {}): string {
	const statement = {
		predicateType: "https://slsa.dev/provenance/v1",
		subject: [{ name: ASSET, digest: { sha256: sha256Hex(TARBALL) } }],
		predicate: {
			buildDefinition: {
				externalParameters: {
					workflow: {
						repository: "https://github.com/lucasreali/cortex-cli",
						path: ".github/workflows/release.yml",
						ref: `refs/tags/${TAG}`,
					},
				},
			},
		},
		...overrides,
	};
	return JSON.stringify({
		attestations: [
			{
				bundle: { dsseEnvelope: { payload: btoa(JSON.stringify(statement)) } },
			},
		],
	});
}

let server: ReturnType<typeof Bun.serve>;
let release: Release;

function origin(): string {
	return `http://localhost:${server.port}`;
}

function missing(): Response {
	return new Response("not found", { status: 404 });
}

beforeEach(() => {
	release = {
		location: `/releases/tag/${TAG}`,
		checksums: `${sha256Hex(TARBALL)}  ${ASSET}\n`,
		tarball: TARBALL,
		attestations: provenance(),
	};
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/releases/latest") {
				if (!release.location) return new Response("gone", { status: 404 });
				return new Response(null, {
					status: 302,
					headers: { location: release.location },
				});
			}
			if (path.endsWith("/checksums.txt")) {
				return release.checksums ? new Response(release.checksums) : missing();
			}
			if (path.endsWith(`/${ASSET}`)) {
				return release.tarball ? new Response(release.tarball) : missing();
			}
			if (path === `/attestations/sha256:${sha256Hex(TARBALL)}`) {
				return release.attestations
					? new Response(release.attestations)
					: missing();
			}
			return missing();
		},
	});
});

afterEach(() => {
	server.stop(true);
});

describe("latestTag", () => {
	test("reads the tag out of the releases/latest redirect", async () => {
		expect(await latestTag(origin())).toBe(TAG);
	});

	test("fails when the redirect does not point at a tag", async () => {
		release.location = "/releases";
		expect(latestTag(origin())).rejects.toThrow("no published release found");
	});

	// A repository that was renamed redirects to its new path, so the host is
	// what has to match — but only the host: the origin allowlist would be worth
	// nothing if a Location header could send the download somewhere else.
	test("follows a redirect to another path on the same host", async () => {
		release.location = `${origin()}/renamed/repo/releases/tag/${TAG}`;
		expect(await latestTag(origin())).toBe(TAG);
	});

	test("refuses a redirect that leaves the origin", async () => {
		release.location = `https://attacker.tld/releases/tag/${TAG}`;
		expect(latestTag(origin())).rejects.toThrow("no published release found");
	});

	test("refuses a tag that is not one a release could be named", async () => {
		release.location = "/releases/tag/..%2F..%2Fetc";
		expect(latestTag(origin())).rejects.toThrow("not a release version");
	});

	test("fails when nothing has been released", async () => {
		release.location = null;
		expect(latestTag(origin())).rejects.toThrow("no published release found");
	});
});

describe("downloadRelease", () => {
	test("returns the asset once its checksum matches", async () => {
		expect(await downloadRelease(origin(), TAG, TARGET)).toEqual(TARBALL);
	});

	test("refuses an asset whose bytes were tampered with", async () => {
		release.tarball = new TextEncoder().encode("something else entirely");
		expect(downloadRelease(origin(), TAG, TARGET)).rejects.toThrow(
			"checksum mismatch",
		);
	});

	test("refuses an asset the release does not vouch for", async () => {
		release.checksums = `${sha256Hex(TARBALL)}  cortex-v9.9.9-darwin-x64.tar.gz\n`;
		expect(downloadRelease(origin(), TAG, TARGET)).rejects.toThrow(
			"is not listed in checksums.txt",
		);
	});

	test("reports a missing checksums file", async () => {
		release.checksums = null;
		expect(downloadRelease(origin(), TAG, TARGET)).rejects.toThrow(
			"download failed: HTTP 404",
		);
	});

	// checksums.txt is a line per published asset. A body far past that is a
	// server that will not stop talking, and reading it to the end is this
	// process's memory.
	test("refuses a download larger than a release can be", async () => {
		release.checksums = "x".repeat(64 * 1024 + 1);
		expect(downloadRelease(origin(), TAG, TARGET)).rejects.toThrow(
			"larger than the",
		);
	});

	test("refuses an asset with no attestation from the release workflow", async () => {
		for (const attestations of [
			null,
			"not json",
			JSON.stringify({ attestations: [{ bundle: { dsseEnvelope: {} } }] }),
			JSON.stringify({
				attestations: [{ bundle: { dsseEnvelope: { payload: "%%%" } } }],
			}),
			provenance({ subject: [{ digest: { sha256: "0".repeat(64) } }] }),
			provenance({
				predicate: {
					buildDefinition: {
						externalParameters: {
							workflow: {
								repository: "https://github.com/someone/fork",
								path: ".github/workflows/release.yml",
								ref: `refs/tags/${TAG}`,
							},
						},
					},
				},
			}),
		]) {
			release.attestations = attestations;
			expect(downloadRelease(origin(), TAG, TARGET)).rejects.toThrow(
				"refusing to install",
			);
		}
	});

	test("refuses a body that keeps streaming past the limit", async () => {
		server.stop(true);
		server = Bun.serve({
			port: 0,
			fetch() {
				const chunk = new Uint8Array(32 * 1024);
				let sent = 0;
				return new Response(
					new ReadableStream({
						pull(controller) {
							sent += chunk.length;
							controller.enqueue(chunk);
							if (sent > 128 * 1024) controller.close();
						},
					}),
				);
			},
		});
		expect(downloadRelease(origin(), TAG, TARGET)).rejects.toThrow(
			"larger than the",
		);
	});

	test("reports an asset missing for this platform", async () => {
		release.tarball = null;
		expect(downloadRelease(origin(), TAG, TARGET)).rejects.toThrow(
			"download failed: HTTP 404",
		);
	});
});
