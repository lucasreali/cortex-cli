import { Checksums } from "./checksums";
import { assetName, assetUrl, checksumsUrl } from "./target";

const RESOLVE_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// Resolving through the /releases/latest redirect instead of the GitHub API
// keeps the upgrade path token-free and outside the 60 requests/hour
// unauthenticated limit — install.sh resolves it the same way.
export async function latestTag(origin: string): Promise<string> {
	const response = await fetch(`${origin}/releases/latest`, {
		redirect: "manual",
		signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
	});
	const tag = response.headers.get("location")?.split("/releases/tag/")[1];
	if (tag) return tag;
	throw new Error(`no published release found at ${origin}/releases`);
}

export async function downloadRelease(
	origin: string,
	tag: string,
	target: string,
): Promise<Uint8Array<ArrayBuffer>> {
	const asset = assetName(tag, target);
	const checksums = new Checksums(
		await (await request(checksumsUrl(origin, tag))).text(),
	);
	const tarball = new Uint8Array(
		await (await request(assetUrl(origin, tag, asset))).arrayBuffer(),
	);
	checksums.verify(asset, tarball);
	return tarball;
}

async function request(url: string): Promise<Response> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (response.ok) return response;
	throw new Error(`download failed: HTTP ${response.status} (${url})`);
}
