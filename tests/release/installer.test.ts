import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBinaryPath, installBinary } from "@/release/installer";

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
