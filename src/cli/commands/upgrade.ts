import { parseArgs } from "node:util";
import { reportFailure, usageError } from "@/cli/error-output";
import { printJson } from "@/cli/json";
import { style, success } from "@/cli/style";
import { daemonPathsFor } from "@/embedding/daemon/paths";
import { stopDaemon } from "@/embedding/daemon/stop";
import { GEMMA_MODEL } from "@/embedding/model";
import { readCortexBinary } from "@/release/archive";
import { downloadRelease, latestTag } from "@/release/catalog";
import { installBinary, upgradeTargetPath } from "@/release/installer";
import {
	assetName,
	buildTarget,
	normalizeTag,
	releaseOrigin,
	versionFromTag,
} from "@/release/target";
import { CORTEX_VERSION } from "@/version";

export async function runUpgrade(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			check: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			version: { type: "string" },
			force: { type: "boolean", default: false },
		},
	});
	if (values.json && !values.check) return usageError("upgrade");
	if (values.check) return await runCheck(values.version, values.json);
	const targetPath = upgradeTargetPath();
	if (!targetPath) {
		reportFailure(
			"upgrade replaces the installed binary — this is a source checkout, use git pull",
		);
		return 1;
	}
	const origin = releaseOrigin();
	const tag = await resolveTag(origin, values.version);
	if (!worthInstalling(tag, Boolean(values.version) || values.force)) {
		console.log(`cortex ${CORTEX_VERSION} is already the latest release`);
		return 0;
	}
	await install(origin, tag, targetPath);
	return 0;
}

async function runCheck(
	version: string | undefined,
	json: boolean,
): Promise<number> {
	const origin = releaseOrigin();
	return report(await resolveTag(origin, version), json);
}

// A pinned version is the answer already; asking the origin for the latest one
// would be a round trip whose result is thrown away.
async function resolveTag(
	origin: string,
	version: string | undefined,
): Promise<string> {
	return version ? normalizeTag(version) : await latestTag(origin);
}

function report(tag: string, json: boolean): number {
	const latest = versionFromTag(tag);
	if (json) {
		printJson({
			current: CORTEX_VERSION,
			latest,
			target: buildTarget(),
			upToDate: !isNewer(tag),
		});
		return 0;
	}
	if (!isNewer(tag)) {
		console.log(`cortex ${CORTEX_VERSION} is up to date`);
		return 0;
	}
	console.log(`cortex ${CORTEX_VERSION} → ${latest} available`);
	console.log(`run ${style.cyan("cortex upgrade")} to update`);
	return 0;
}

function worthInstalling(tag: string, requested: boolean): boolean {
	return requested || isNewer(tag);
}

function isNewer(tag: string): boolean {
	return Bun.semver.order(versionFromTag(tag), CORTEX_VERSION) === 1;
}

async function install(
	origin: string,
	tag: string,
	targetPath: string,
): Promise<void> {
	const target = buildTarget();
	// The origin is named before anything is fetched: this command replaces the
	// binary that runs on every prompt, so where the replacement came from is
	// not a detail to keep to itself.
	console.log(`Downloading ${assetName(tag, target)} from ${origin}`);
	const tarball = await downloadRelease(origin, tag, target);
	await installBinary({
		binary: readCortexBinary(tarball),
		version: versionFromTag(tag),
		targetPath,
	});
	console.log(success(`cortex ${tag} installed to ${style.cyan(targetPath)}`));
	announceDaemon();
	console.log(
		style.dim(
			"\nAn MCP server already running keeps the old binary until its client restarts it.",
		),
	);
	console.log(style.dim("Run cortex doctor in a project to check its store."));
}

function announceDaemon(): void {
	if (!stopDaemon(daemonPathsFor(GEMMA_MODEL.modelId))) return;
	console.log(success("Stopped the embedding daemon from the old version"));
}
