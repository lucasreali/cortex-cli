import { chmodSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { CORTEX_VERSION } from "@/version";
import { compile, ROOT } from "./compile";

const TARGETS: ReadonlyArray<{
	target: Bun.Build.CompileTarget;
	suffix: string;
}> = [
	{ target: "bun-darwin-arm64", suffix: "darwin-arm64" },
	{ target: "bun-darwin-x64", suffix: "darwin-x64" },
	{ target: "bun-linux-x64", suffix: "linux-x64" },
	{ target: "bun-linux-arm64", suffix: "linux-arm64" },
	{ target: "bun-linux-x64-musl", suffix: "linux-x64-musl" },
	{ target: "bun-linux-arm64-musl", suffix: "linux-arm64-musl" },
	{ target: "bun-linux-x64-baseline", suffix: "linux-x64-baseline" },
];

const TAG = `v${CORTEX_VERSION}`;
const RELEASE_DIR = join(ROOT, "dist", "release");
const STAGE_DIR = join(ROOT, "dist", "stage");

function createTar(
	stageDir: string,
	ownerFlags: string[],
): Bun.SyncSubprocess<"pipe", "pipe"> {
	return Bun.spawnSync(
		[
			"tar",
			"--format=ustar",
			"--numeric-owner",
			...ownerFlags,
			"-cf",
			"-",
			"-C",
			stageDir,
			"cortex",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
}

// Mode and mtime are normalized on disk and the gzip wrapper is written by Bun,
// so the tar binary is left with flags GNU tar and bsdtar both accept. --owner
// is the exception: libarchive gained it late enough that the version macOS
// ships may reject it, so it degrades to the builder's uid rather than failing.
async function archive(stageDir: string, outfile: string): Promise<void> {
	const binary = join(stageDir, "cortex");
	chmodSync(binary, 0o755);
	utimesSync(binary, 0, 0);
	let tar = createTar(stageDir, ["--owner=0", "--group=0"]);
	if (tar.exitCode !== 0) {
		tar = createTar(stageDir, []);
	}
	if (tar.exitCode !== 0) {
		console.error(tar.stderr.toString().trim());
		throw new Error(`tar exited ${tar.exitCode}`);
	}
	await Bun.write(
		outfile,
		Bun.gzipSync(new Uint8Array(tar.stdout), { level: 9 }),
	);
}

async function sha256(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(path).arrayBuffer());
	return hasher.digest("hex");
}

async function packageTarget(
	target: Bun.Build.CompileTarget,
	suffix: string,
): Promise<{ asset: string; stageDir: string }> {
	const stageDir = join(STAGE_DIR, suffix);
	mkdirSync(stageDir, { recursive: true });
	await compile({ outfile: join(stageDir, "cortex"), target, suffix });
	const asset = `cortex-${TAG}-${suffix}.tar.gz`;
	await archive(stageDir, join(RELEASE_DIR, asset));
	console.log(`${asset} (${sizeInMegabytes(join(RELEASE_DIR, asset))} MB)`);
	return { asset, stageDir };
}

function sizeInMegabytes(path: string): string {
	return (Bun.file(path).size / 1024 / 1024).toFixed(1);
}

rmSync(RELEASE_DIR, { recursive: true, force: true });
rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(RELEASE_DIR, { recursive: true });

const assets: string[] = [];
let sharedSourcemapDir = "";
for (const { target, suffix } of TARGETS) {
	const packaged = await packageTarget(target, suffix);
	assets.push(packaged.asset);
	sharedSourcemapDir ||= packaged.stageDir;
}

const sourcemap = `cortex-${TAG}.js.map`;
await Bun.write(
	join(RELEASE_DIR, sourcemap),
	Bun.file(join(sharedSourcemapDir, "main.js.map")),
);
assets.push(sourcemap);

const lines = await Promise.all(
	assets.map(
		async (asset) => `${await sha256(join(RELEASE_DIR, asset))}  ${asset}`,
	),
);
await Bun.write(join(RELEASE_DIR, "checksums.txt"), `${lines.join("\n")}\n`);

rmSync(STAGE_DIR, { recursive: true, force: true });
console.log(`\n${assets.length + 1} assets in ${RELEASE_DIR}`);
