import { parseArgs } from "node:util";
import { printJson } from "@/cli/json";
import { failure, style, success } from "@/cli/style";
import { daemonPathsFor } from "@/embedding/daemon/paths";
import { stopDaemon } from "@/embedding/daemon/stop";
import { GEMMA_MODEL } from "@/embedding/model";
import { RUNS_FROM_COMPILED_BINARY } from "@/embedding/subprocess-command";
import { readCortexBinary } from "@/release/archive";
import { downloadRelease, latestTag } from "@/release/catalog";
import { currentBinaryPath, installBinary } from "@/release/installer";
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
	if (values.json && !values.check) {
		console.error(
			"usage: cortex upgrade [--check [--json]] [--version V] [--force]",
		);
		return 1;
	}
	if (!values.check && !RUNS_FROM_COMPILED_BINARY) {
		console.error(
			failure(
				"upgrade replaces the installed binary — this is a source checkout, use git pull",
			),
		);
		return 1;
	}
	const origin = releaseOrigin();
	const tag = values.version
		? normalizeTag(values.version)
		: await latestTag(origin);
	if (values.check) return report(tag, values.json);
	if (!worthInstalling(tag, Boolean(values.version) || values.force)) {
		console.log(`cortex ${CORTEX_VERSION} is already the latest release`);
		return 0;
	}
	await install(origin, tag);
	return 0;
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

async function install(origin: string, tag: string): Promise<void> {
	const target = buildTarget();
	console.log(`Downloading ${assetName(tag, target)}`);
	const tarball = await downloadRelease(origin, tag, target);
	const targetPath = currentBinaryPath();
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
