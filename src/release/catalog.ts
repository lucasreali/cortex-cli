import { errorMessage } from "@/support/errors";
import { sha256Hex } from "@/support/hash";
import { Checksums } from "./checksums";
import {
	assetName,
	assetUrl,
	attestationsEndpoint,
	checksumsUrl,
	normalizeTag,
	RELEASE_REPOSITORY,
} from "./target";

const RESOLVE_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// An asset is the compiled binary gzipped, and that binary is a little over
// 100 MB before compression, so these leave every real release room to grow
// while a body that never ends is refused instead of filling this process.
const MAXIMUM_ASSET_BYTES = 200 * 1024 * 1024;
const MAXIMUM_CHECKSUMS_BYTES = 64 * 1024;

const MAXIMUM_ATTESTATION_BYTES = 4 * 1024 * 1024;

const TAG_PATH = "/releases/tag/";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const PROVENANCE = "https://slsa.dev/provenance/v1";

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
	await verifyProvenance(attestationsEndpoint(origin), tag, tarball);
	return tarball;
}

// checksums.txt is served by the same origin as the asset, so it detects a
// corrupt download and nothing else. The release workflow also records a
// build-provenance attestation for every asset, and GitHub only accepts one
// from a workflow running in this repository: an asset whose digest has no
// attestation naming this repository's release workflow at this tag was not
// built by it. What this does not do is check the Sigstore signature itself —
// `gh attestation verify` is that check, and docs/distribution.md says so.
async function verifyProvenance(
	endpoint: string,
	tag: string,
	tarball: Uint8Array,
): Promise<void> {
	const digest = sha256Hex(tarball);
	let statements: ProvenanceStatement[];
	try {
		const listing = await download(
			`${endpoint}/sha256:${digest}`,
			MAXIMUM_ATTESTATION_BYTES,
		);
		statements = statementsIn(new TextDecoder().decode(listing));
	} catch (error) {
		throw unattested(errorMessage(error));
	}
	if (statements.some((statement) => vouchesFor(statement, digest, tag))) {
		return;
	}
	throw unattested("none of its attestations names this release");
}

function unattested(reason: string): Error {
	return new Error(
		`refusing to install: could not confirm a build-provenance attestation ` +
			`from ${RELEASE_REPOSITORY}'s release workflow for this download ` +
			`(${reason})`,
	);
}

interface ProvenanceStatement {
	predicateType?: string;
	subject?: Array<{ digest?: { sha256?: string } }>;
	predicate?: {
		buildDefinition?: {
			externalParameters?: {
				workflow?: { repository?: string; path?: string; ref?: string };
			};
		};
	};
}

function statementsIn(body: string): ProvenanceStatement[] {
	try {
		const parsed = JSON.parse(body) as {
			attestations?: Array<{
				bundle?: { dsseEnvelope?: { payload?: string } };
			}>;
		};
		return (parsed.attestations ?? []).flatMap((attestation) => {
			const payload = attestation.bundle?.dsseEnvelope?.payload;
			if (!payload) return [];
			try {
				return [JSON.parse(atob(payload)) as ProvenanceStatement];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

function vouchesFor(
	statement: ProvenanceStatement,
	digest: string,
	tag: string,
): boolean {
	const workflow =
		statement.predicate?.buildDefinition?.externalParameters?.workflow;
	return (
		statement.predicateType === PROVENANCE &&
		(statement.subject ?? []).some(
			(subject) => subject.digest?.sha256 === digest,
		) &&
		workflow?.repository === `https://github.com/${RELEASE_REPOSITORY}` &&
		workflow.path === RELEASE_WORKFLOW &&
		workflow.ref === `refs/tags/${tag}`
	);
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
	return await readWithin(response, url, limit);
}

// The limit is enforced while the body streams, not after: reading a body to
// the end before measuring it is exactly the memory the limit exists to keep.
async function readWithin(
	response: Response,
	url: string,
	limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const tooLarge = () =>
		new Error(
			`download failed: ${url} is larger than the ${limit} bytes a release can be`,
		);
	if (Number(response.headers.get("content-length") ?? 0) > limit) {
		await response.body?.cancel();
		throw tooLarge();
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body?.getReader();
	while (reader) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > limit) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}
