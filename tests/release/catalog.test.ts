import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { downloadRelease, latestTag } from "@/release/catalog";
import { sha256Hex } from "@/release/checksums";
import { assetName } from "@/release/target";
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
		location: `https://host/releases/tag/${TAG}`,
		checksums: `${sha256Hex(TARBALL)}  ${ASSET}\n`,
		tarball: TARBALL,
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
		release.location = "https://host/releases";
		expect(latestTag(origin())).rejects.toThrow("no published release found");
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

	test("reports an asset missing for this platform", async () => {
		release.tarball = null;
		expect(downloadRelease(origin(), TAG, TARGET)).rejects.toThrow(
			"download failed: HTTP 404",
		);
	});
});
