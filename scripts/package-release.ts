import { chmodSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { assetName, RELEASE_SUFFIXES } from "@/release/target";
import { sha256Hex } from "@/support/hash";
import { CORTEX_VERSION } from "@/version";
import { compile, executableNameFor, ROOT, sizeInMegabytes } from "./compile";
import { bundledPackages, readNotice, renderNotices } from "./notices";

const TARGETS = RELEASE_SUFFIXES.map((suffix) => ({
	target: `bun-${suffix}` as Bun.Build.CompileTarget,
	suffix,
}));

const TAG = `v${CORTEX_VERSION}`;
const RELEASE_DIR = join(ROOT, "dist", "release");
const STAGE_DIR = join(ROOT, "dist", "stage");
const MODULES_DIR = join(ROOT, "node_modules");
const VENDORED_LICENSES_DIR = join(ROOT, "scripts", "licenses");
const NOTICES = "THIRD-PARTY-NOTICES.md";

// The executable is read first by src/release/archive.ts, which scans members
// until it finds it and never needs the two text files behind it. Its name is
// the target's, not the builder's: a Windows tarball carries cortex.exe.
function membersOf(executable: string): string[] {
	return [executable, "LICENSE", NOTICES];
}

function createTar(
	stageDir: string,
	members: string[],
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
			...members,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
}

// Mode and mtime are normalized on disk and the gzip wrapper is written by Bun,
// so the tar binary is left with flags GNU tar and bsdtar both accept. --owner
// is the exception: libarchive gained it late enough that the version macOS
// ships may reject it, so it degrades to the builder's uid rather than failing.
async function archive(
	stageDir: string,
	executable: string,
	outfile: string,
): Promise<void> {
	const members = membersOf(executable);
	chmodSync(join(stageDir, executable), 0o755);
	for (const member of members) {
		utimesSync(join(stageDir, member), 0, 0);
	}
	let tar = createTar(stageDir, members, ["--owner=0", "--group=0"]);
	if (tar.exitCode !== 0) {
		tar = createTar(stageDir, members, []);
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
	return sha256Hex(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

// Apache-2.0 §4 requires the license text and the attribution to travel with
// the redistributed work, and the tarball is the only thing a user receives.
// The list comes from this target's own sourcemap, so a tarball can never name
// a package the binary beside it does not contain.
async function stageNotices(stageDir: string): Promise<void> {
	const sourcemap = await Bun.file(join(stageDir, "main.js.map")).text();
	const packages = bundledPackages(sourcemap, repositorySources);
	const notices = await Promise.all(
		packages.map((name) =>
			readNotice(name, MODULES_DIR, VENDORED_LICENSES_DIR),
		),
	);
	await Bun.write(join(stageDir, "LICENSE"), Bun.file(join(ROOT, "LICENSE")));
	await Bun.write(join(stageDir, NOTICES), renderNotices(TAG, notices));
}

function run(command: string[]): void {
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		console.error(result.stderr.toString().trim());
		throw new Error(`${command.join(" ")} exited ${result.exitCode}`);
	}
}

// Bun leaves a cross-compiled darwin binary with a signature that no longer
// covers the bytes it appended: the linker's ad-hoc one on arm64, Bun's own on
// x64. Older macOS ran it anyway; recent releases kill it at exec with SIGKILL,
// which is how 0.6.1 and 0.7.0 shipped binaries no Mac could start. Only
// Apple's codesign is trusted to re-sign here, so darwin assets are packaged on
// macOS or not at all.
function signForMacOS(binary: string): void {
	if (process.platform !== "darwin") {
		throw new Error("darwin assets must be packaged on macOS, to be re-signed");
	}
	run(["codesign", "--force", "--sign", "-", "--identifier", "cortex", binary]);
	run(["codesign", "--verify", "--strict", binary]);
}

async function packageTarget(
	target: Bun.Build.CompileTarget,
	suffix: string,
): Promise<{ asset: string; stageDir: string }> {
	const stageDir = join(STAGE_DIR, suffix);
	const executable = executableNameFor(suffix);
	mkdirSync(stageDir, { recursive: true });
	await compile({ outfile: join(stageDir, executable), target, suffix });
	if (suffix.startsWith("darwin-")) {
		signForMacOS(join(stageDir, executable));
	}
	await stageNotices(stageDir);
	const asset = assetName(TAG, suffix);
	await archive(stageDir, executable, join(RELEASE_DIR, asset));
	console.log(`${asset} (${sizeInMegabytes(join(RELEASE_DIR, asset))} MB)`);
	return { asset, stageDir };
}

// An asset reaches the bundle through a `type: "file"` import and leaves no
// sourcemap entry, so the package it came from is read off the importing source.
const repositorySources = (
	await Promise.all(
		(
			await Array.fromAsync(new Bun.Glob("src/**/*.ts").scan(ROOT))
		).map((file) => Bun.file(join(ROOT, file)).text()),
	)
).join("\n");

rmSync(RELEASE_DIR, { recursive: true, force: true });
rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(RELEASE_DIR, { recursive: true });

const assets: string[] = [];
// Each target compiles with its own CORTEX_BUILD_TARGET define, so the bundles
// are not byte-identical and one shared map would mislocate frames for six of
// the seven.
for (const { target, suffix } of TARGETS) {
	const packaged = await packageTarget(target, suffix);
	assets.push(packaged.asset);
	const sourcemap = `cortex-${TAG}-${suffix}.js.map`;
	await Bun.write(
		join(RELEASE_DIR, sourcemap),
		Bun.file(join(packaged.stageDir, "main.js.map")),
	);
	assets.push(sourcemap);
}

// Checksums refuses a listing that names one asset twice, and install.sh fails
// the comparison for the same reason, so a name collision here would publish a
// release nobody can install. Cheaper to find it before the upload.
if (new Set(assets).size !== assets.length) {
	throw new Error("two release assets share a name");
}

const lines = await Promise.all(
	assets.map(
		async (asset) => `${await sha256(join(RELEASE_DIR, asset))}  ${asset}`,
	),
);
await Bun.write(join(RELEASE_DIR, "checksums.txt"), `${lines.join("\n")}\n`);

rmSync(STAGE_DIR, { recursive: true, force: true });
console.log(`\n${assets.length + 1} assets in ${RELEASE_DIR}`);
