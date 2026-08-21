import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const INSTALL_SH = join(REPO_ROOT, "install.sh");
const VERSION = "v9.9.9";
const PREVIOUS = "#!/bin/sh\necho 1.0.0\n";

let root: string;
let fixtures: string;
let installDir: string;
let stubs: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-install-sh-")));
	fixtures = join(root, "fixtures");
	installDir = join(root, "bin");
	stubs = join(root, "stubs");
	for (const directory of [fixtures, installDir, stubs]) {
		mkdirSync(directory, { recursive: true });
	}
	writeStubCurl();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function run(command: string[]) {
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

// The script downloads from github.com; a curl on PATH that serves a local
// fixture directory is what makes its install path testable at all.
function writeStubCurl(): void {
	const path = join(stubs, "curl");
	writeFileSync(
		path,
		[
			"#!/bin/sh",
			'out=""',
			'url=""',
			"while [ $# -gt 0 ]; do",
			'  case "$1" in',
			'  -o) out="$2"; shift 2 ;;',
			'  http*) url="$1"; shift ;;',
			"  *) shift ;;",
			"  esac",
			"done",
			'[ -f "$CORTEX_FIXTURES/${url##*/}" ] || exit 22',
			'cp "$CORTEX_FIXTURES/${url##*/}" "$out"',
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

let cachedSuffix: string | null = null;

function suffix(): string {
	cachedSuffix ??= run([
		"sh",
		"-c",
		"CORTEX_SOURCE_ONLY=1 . ./install.sh; detect_suffix",
	]).stdout.trim();
	return cachedSuffix;
}

function assetName(): string {
	return `cortex-${VERSION}-${suffix()}.tar.gz`;
}

// A cortex that behaves however the test needs, so the probe the installer now
// runs before the rename has something real to accept or refuse.
function publishRelease(behaviour: string): void {
	const payload = join(root, "payload");
	mkdirSync(payload, { recursive: true });
	writeFileSync(join(payload, "cortex"), `#!/bin/sh\n${behaviour}\n`);
	run(["tar", "-czf", join(fixtures, assetName()), "-C", payload, "cortex"]);
	publishChecksum(
		run(["sha256sum", join(fixtures, assetName())]).stdout.split(" ")[0] ?? "",
	);
}

function publishChecksum(digest: string): void {
	writeFileSync(join(fixtures, "checksums.txt"), `${digest}  ${assetName()}\n`);
}

function seedInstalledBinary(): void {
	writeFileSync(join(installDir, "cortex"), PREVIOUS);
	chmodSync(join(installDir, "cortex"), 0o755);
}

function runInstaller(extra: Record<string, string> = {}) {
	const result = Bun.spawnSync(["sh", INSTALL_SH], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH ?? ""}`,
			HOME: root,
			CORTEX_FIXTURES: fixtures,
			CORTEX_INSTALL_DIR: installDir,
			CORTEX_VERSION: VERSION,
			...extra,
		},
	});
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

// M33: the binary was published with an `mv` out of tmpfs, which coreutils
// resolves by unlinking the destination and copying ~60 MB into a fresh inode.
// For the length of that copy the installed cortex is a truncated but already
// executable file, and nothing ever checked that what landed runs — so a Ctrl-C
// left a broken binary that `cortex upgrade` could not repair, because it was
// the broken binary. It is staged inside $INSTALL_DIR, probed, then renamed.
describe("install.sh publishes by rename, after proving the binary runs", () => {
	test("installs a binary that reports the expected version", () => {
		publishRelease("echo 9.9.9");
		expect(runInstaller().code).toBe(0);
		expect(readdirSync(installDir)).toEqual(["cortex"]);
		expect(run([join(installDir, "cortex"), "--version"]).stdout.trim()).toBe(
			"9.9.9",
		);
	});

	test("keeps the installed binary when the download reports another version", () => {
		seedInstalledBinary();
		publishRelease("echo 1.2.3");

		const result = runInstaller();
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("reports v1.2.3");
		expect(readFileSync(join(installDir, "cortex"), "utf8")).toBe(PREVIOUS);
		expect(readdirSync(installDir)).toEqual(["cortex"]);
	});

	test("keeps the installed binary when the download cannot run here", () => {
		seedInstalledBinary();
		publishRelease("exit 3");

		const result = runInstaller();
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("does not run here");
		expect(readFileSync(join(installDir, "cortex"), "utf8")).toBe(PREVIOUS);
		expect(readdirSync(installDir)).toEqual(["cortex"]);
	});

	test("a checksum mismatch stops before anything is staged", () => {
		publishRelease("echo 9.9.9");
		publishChecksum("0".repeat(64));

		const result = runInstaller();
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("checksum mismatch");
		expect(readdirSync(installDir)).toEqual([]);
	});

	test("says so when the asset cannot be downloaded", () => {
		const result = runInstaller();
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("failed to download");
	});

	// L5: the lookup ran inside a command substitution under `set -eu`, so a
	// curl that failed exited the whole script with no message at all.
	test("says so when the latest release cannot be resolved", () => {
		const result = runInstaller({ CORTEX_VERSION: "" });
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("could not reach");
	});
});
