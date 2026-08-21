import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	currentBinaryPath,
	installBinary,
	upgradeTargetPath,
} from "@/release/installer";
import { stagingPath } from "@/support/atomic-write";

const OLD = "#!/bin/sh\necho 0.0.1\n";

function script(version: string): Uint8Array {
	return new TextEncoder().encode(`#!/bin/sh\necho ${version}\n`);
}

const tempDirs: string[] = [];

function makeInstallDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-install-")));
	tempDirs.push(dir);
	writeFileSync(join(dir, "cortex"), OLD, { mode: 0o755 });
	return dir;
}

function run(path: string): string {
	return Bun.spawnSync([path], { stdout: "pipe" }).stdout.toString().trim();
}

// A pid the kernel has already reaped: spawning and awaiting one is the only
// way to name a process that is certainly gone.
async function deadPid(): Promise<number> {
	const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	return child.pid;
}

function leftovers(dir: string): string[] {
	return readdirSync(dir).filter((name) => name !== "cortex");
}

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("currentBinaryPath", () => {
	test("resolves the executable this process is running", () => {
		expect(existsSync(currentBinaryPath())).toBe(true);
	});
});

describe("installBinary", () => {
	test("replaces the binary and leaves no staging file behind", async () => {
		const dir = makeInstallDir();
		const targetPath = join(dir, "cortex");
		await installBinary({
			binary: script("9.9.9"),
			version: "9.9.9",
			targetPath,
		});
		expect(run(targetPath)).toBe("9.9.9");
		expect(leftovers(dir)).toEqual([]);
	});

	// A symlinked cortex must stay a symlink: replacing the link itself would
	// leave the real file stale and break every other path pointing at it.
	test("replaces the file a symlink resolves to, not the symlink", async () => {
		const dir = makeInstallDir();
		const link = join(dir, "cortex-link");
		symlinkSync(join(dir, "cortex"), link);
		await installBinary({
			binary: script("9.9.9"),
			version: "9.9.9",
			targetPath: realpathSync(link),
		});
		expect(run(link)).toBe("9.9.9");
		expect(run(join(dir, "cortex"))).toBe("9.9.9");
	});

	test("keeps the old binary when the download reports another version", async () => {
		const dir = makeInstallDir();
		const targetPath = join(dir, "cortex");
		expect(
			installBinary({ binary: script("1.1.1"), version: "9.9.9", targetPath }),
		).rejects.toThrow("does not run here");
		await Bun.sleep(0);
		expect(run(targetPath)).toBe("0.0.1");
		expect(leftovers(dir)).toEqual([]);
	});

	test("keeps the old binary when the download cannot run at all", async () => {
		const dir = makeInstallDir();
		const targetPath = join(dir, "cortex");
		expect(
			installBinary({
				binary: new Uint8Array([0, 1, 2, 3]),
				version: "9.9.9",
				targetPath,
			}),
		).rejects.toThrow("does not run here");
		await Bun.sleep(0);
		expect(run(targetPath)).toBe("0.0.1");
	});

	// The staging path is the target plus this process's pid, so anyone who can
	// write to the install directory can guess it. Following a symlink left
	// there would chmod 0755 whatever it points at and then rename the link
	// itself over cortex.
	test("refuses a symlink planted at the staging path", async () => {
		const dir = makeInstallDir();
		const targetPath = join(dir, "cortex");
		const victim = join(dir, "victim");
		writeFileSync(victim, "untouched", { mode: 0o600 });
		symlinkSync(victim, stagingPath(targetPath));

		await installBinary({
			binary: script("9.9.9"),
			version: "9.9.9",
			targetPath,
		});

		expect(readFileSync(victim, "utf8")).toBe("untouched");
		expect(run(targetPath)).toBe("9.9.9");
		expect(leftovers(dir)).toEqual(["victim"]);
	});

	test("reclaims the staging files an interrupted upgrade left behind", async () => {
		const dir = makeInstallDir();
		const targetPath = join(dir, "cortex");
		const abandoned = await deadPid();
		writeFileSync(join(dir, `cortex.${abandoned}.partial`), "abandoned");
		writeFileSync(join(dir, "cortex.1.partial"), "another upgrade running");
		writeFileSync(join(dir, "cortex.notapid.partial"), "not ours");
		writeFileSync(join(dir, "cortex.bak"), "not staging at all");

		await installBinary({
			binary: script("9.9.9"),
			version: "9.9.9",
			targetPath,
		});

		expect(leftovers(dir).sort()).toEqual([
			"cortex.1.partial",
			"cortex.bak",
			"cortex.notapid.partial",
		]);
	});

	test("installs into a directory that is not there yet", async () => {
		const dir = makeInstallDir();
		const targetPath = join(dir, "made-up", "cortex");

		await installBinary({
			binary: script("9.9.9"),
			version: "9.9.9",
			targetPath,
		});

		expect(run(targetPath)).toBe("9.9.9");
	});

	test("explains an install directory this user cannot write to", async () => {
		const dir = makeInstallDir();
		const guarded = join(dir, "guarded");
		mkdirSync(guarded);
		const targetPath = join(guarded, "cortex");
		writeFileSync(targetPath, OLD, { mode: 0o755 });
		chmodSync(guarded, 0o500);
		try {
			expect(
				installBinary({
					binary: script("9.9.9"),
					version: "9.9.9",
					targetPath,
				}),
			).rejects.toThrow("is not writable");
			await Bun.sleep(0);
		} finally {
			chmodSync(guarded, 0o700);
		}
		expect(run(targetPath)).toBe("0.0.1");
	});
});

// The seam that lets a source checkout drive the whole install path against a
// file of its own. It follows CORTEX_RELEASE_BASE_URL's rule, and this is where
// that rule is pinned: an installed binary replaces itself and nothing else.
describe("upgradeTargetPath", () => {
	const previous = process.env.CORTEX_UPGRADE_TARGET_PATH;

	afterEach(() => {
		if (previous === undefined) delete process.env.CORTEX_UPGRADE_TARGET_PATH;
		else process.env.CORTEX_UPGRADE_TARGET_PATH = previous;
	});

	test("a compiled binary replaces itself", () => {
		delete process.env.CORTEX_UPGRADE_TARGET_PATH;
		expect(upgradeTargetPath(true)).toBe(currentBinaryPath());
	});

	test("a source checkout has nothing to replace", () => {
		delete process.env.CORTEX_UPGRADE_TARGET_PATH;
		expect(upgradeTargetPath(false)).toBeNull();
	});

	test("a source checkout takes the file the environment names", () => {
		const dir = makeInstallDir();
		process.env.CORTEX_UPGRADE_TARGET_PATH = join(dir, "cortex");
		expect(upgradeTargetPath(false)).toBe(join(dir, "cortex"));
	});

	// Anything able to set an environment variable would otherwise choose what
	// the download lands on, for every later cortex on the machine.
	test("an installed binary ignores the environment entirely", () => {
		process.env.CORTEX_UPGRADE_TARGET_PATH = join(makeInstallDir(), "cortex");
		expect(upgradeTargetPath(true)).toBe(currentBinaryPath());
	});
});
