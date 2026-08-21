import { Checksums } from "./checksums";
import { assetName, assetUrl, checksumsUrl, normalizeTag } from "./target";

const RESOLVE_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// An asset is the compiled binary gzipped, and that binary is a little over
// 100 MB before compression, so these leave every real release room to grow
// while a body that never ends is refused instead of filling this process.
const MAXIMUM_ASSET_BYTES = 200 * 1024 * 1024;
const MAXIMUM_CHECKSUMS_BYTES = 64 * 1024;

const TAG_PATH = "/releases/tag/";

// Resolving through the /releases/latest redirect instead of the GitHub API
// keeps the upgrade path token-free and outside the 60 requests/hour
// unauthenticated limit — install.sh resolves it the same way.
export async function latestTag(origin: string): Promise<string> {
	const response = await fetch(`${origin}/releases/latest`, {
		redirect: "manual",
		signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
	});
	const tag = taggedBy(origin, response.headers.get("location"));
	if (tag) return normalizeTag(tag);
	throw new Error(`no published release found at ${origin}/releases`);
}

// A redirect names where to look next, and the origin allowlist would be worth
// nothing if a Location header could send the download elsewhere. GitHub answers
// a renamed repository with its new path, so the host is what has to match, not
// the whole prefix.
function taggedBy(origin: string, location: string | null): string | undefined {
	const redirect = location ? URL.parse(location, origin) : null;
	if (!redirect) return undefined;
	if (redirect.origin !== URL.parse(origin)?.origin) return undefined;
	return redirect.pathname.split(TAG_PATH)[1];
}

export async function downloadRelease(
	origin: string,
	tag: string,
	target: string,
): Promise<Uint8Array<ArrayBuffer>> {
	const asset = assetName(tag, target);
	const checksums = new Checksums(
		new TextDecoder().decode(
			await download(checksumsUrl(origin, tag), MAXIMUM_CHECKSUMS_BYTES),
		),
	);
	const tarball = await download(
		assetUrl(origin, tag, asset),
		MAXIMUM_ASSET_BYTES,
	);
	checksums.verify(asset, tarball);
	return tarball;
}

async function download(
	url: string,
	limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`download failed: HTTP ${response.status} (${url})`);
	}
	return withinLimit(new Uint8Array(await response.arrayBuffer()), url, limit);
}

function withinLimit(
	bytes: Uint8Array<ArrayBuffer>,
	url: string,
	limit: number,
): Uint8Array<ArrayBuffer> {
	if (bytes.length <= limit) return bytes;
	throw new Error(
		`download failed: ${url} is larger than the ${limit} bytes a release can be`,
	);
}
