import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_SUFFIXES } from "@/release/target";

// H19: CI's only exercise of install.sh was `detect_suffix` on the one host it
// runs on, so the darwin, arm64, musl and baseline branches executed nowhere and
// verify() — the only thing between a `curl | sh` user and an unverified binary
// — had no test in any form. The script is already sourceable; these drive its
// functions directly, with the three commands their answers depend on stubbed on
// PATH.
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ASSET = "cortex-v9.9.9-linux-x64.tar.gz";
const PAYLOAD = "the release archive\n";

let root: string;
let stubs: string;
let realGrep: string;
// Some of these tests hand the script a PATH holding nothing but the one tool
// under test, so the shell that runs it has to be named absolutely.
let shell: string;

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-install-fns-")));
	stubs = join(root, "stubs");
	mkdirSync(stubs, { recursive: true });
	realGrep = which("grep");
	shell = which("sh");
	writeStub("uname", [
		'case "$1" in',
		'-s) echo "$CORTEX_UNAME_S" ;;',
		'-m) echo "$CORTEX_UNAME_M" ;;',
		"esac",
	]);
	// A glibc host answers `ldd --version` on stdout, a musl host on stderr and
	// with a non-zero status; is_musl reads both streams, so the stub has to be
	// able to produce either shape.
	writeStub("ldd", ['echo "$CORTEX_LDD" >&2', "exit 1"]);
	// has_avx2 is `grep -q avx2 /proc/cpuinfo`, and the runner's real cpuinfo
	// decides it. Only that one probe is answered here; everything else — is_musl
	// reads ldd's output through grep too — goes to the real one.
	writeStub("grep", [
		'case "$*" in',
		'*/proc/cpuinfo) test "$CORTEX_AVX2" = 1 ;;',
		`*) exec ${realGrep} "$@" ;;`,
		"esac",
	]);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function which(command: string): string {
	const found = Bun.spawnSync(["sh", "-c", `command -v ${command}`], {
		stdout: "pipe",
	});
	return found.stdout.toString().trim();
}

function writeStub(name: string, lines: string[]): void {
	const path = join(stubs, name);
	writeFileSync(path, ["#!/bin/sh", ...lines, ""].join("\n"));
	chmodSync(path, 0o755);
}

// Sourcing gives the shell every function the installer would have called; the
// script itself installs nothing under CORTEX_SOURCE_ONLY.
function call(
	script: string,
	environment: Record<string, string> = {},
	path: string = `${stubs}:${process.env.PATH ?? ""}`,
): Result {
	const result = Bun.spawnSync(
		[shell, "-c", `CORTEX_SOURCE_ONLY=1 . ./install.sh\n${script}`],
		{
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...environment, PATH: path },
		},
	);
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
}

function suffixOn(host: Record<string, string>): Result {
	return call("detect_suffix", host);
}

describe("install.sh detect_suffix", () => {
	const hosts: Array<[string, Record<string, string>, string]> = [
		[
			"an Apple Silicon Mac",
			{ CORTEX_UNAME_S: "Darwin", CORTEX_UNAME_M: "arm64" },
			"darwin-arm64",
		],
		[
			"an Intel Mac",
			{ CORTEX_UNAME_S: "Darwin", CORTEX_UNAME_M: "x86_64" },
			"darwin-x64",
		],
		[
			"Alpine on x86_64",
			{
				CORTEX_UNAME_S: "Linux",
				CORTEX_UNAME_M: "x86_64",
				CORTEX_LDD: "musl libc (x86_64)",
			},
			"linux-x64-musl",
		],
		[
			"Alpine on arm64",
			{
				CORTEX_UNAME_S: "Linux",
				CORTEX_UNAME_M: "aarch64",
				CORTEX_LDD: "musl libc (aarch64)",
			},
			"linux-arm64-musl",
		],
		[
			"a glibc x86_64 host with AVX2",
			{
				CORTEX_UNAME_S: "Linux",
				CORTEX_UNAME_M: "amd64",
				CORTEX_LDD: "ldd (GNU libc) 2.39",
				CORTEX_AVX2: "1",
			},
			"linux-x64",
		],
		[
			"a glibc x86_64 host without AVX2",
			{
				CORTEX_UNAME_S: "Linux",
				CORTEX_UNAME_M: "x86_64",
				CORTEX_LDD: "ldd (GNU libc) 2.39",
				CORTEX_AVX2: "0",
			},
			"linux-x64-baseline",
		],
		// The baseline build exists for x64 only, so an arm64 host with no avx2
		// line in its cpuinfo — which is every arm64 host — is still linux-arm64.
		[
			"a glibc arm64 host",
			{
				CORTEX_UNAME_S: "Linux",
				CORTEX_UNAME_M: "aarch64",
				CORTEX_LDD: "ldd (GNU libc) 2.39",
				CORTEX_AVX2: "0",
			},
			"linux-arm64",
		],
	];

	for (const [name, host, expected] of hosts) {
		test(`${name} asks for ${expected}`, () => {
			const result = suffixOn(host);
			expect(result.code).toBe(0);
			expect(result.stdout).toBe(expected);
		});
	}

	// RELEASE_SUFFIXES is the one list the release workflow compiles from. A
	// suffix this script can ask for that nothing publishes is a 404 on install.
	test("every suffix it can ask for is a published asset", () => {
		for (const [, host, expected] of hosts) {
			expect(RELEASE_SUFFIXES as readonly string[]).toContain(expected);
			expect(suffixOn(host).stdout).toBe(expected);
		}
	});

	test("refuses an OS with no release", () => {
		const result = suffixOn({
			CORTEX_UNAME_S: "FreeBSD",
			CORTEX_UNAME_M: "x86_64",
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("unsupported OS: FreeBSD");
	});

	test("refuses an architecture with no release", () => {
		const result = suffixOn({
			CORTEX_UNAME_S: "Linux",
			CORTEX_UNAME_M: "riscv64",
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("unsupported architecture: riscv64");
	});
});

describe("install.sh verify", () => {
	let assetPath: string;
	let digest: string;

	beforeAll(() => {
		assetPath = join(root, ASSET);
		writeFileSync(assetPath, PAYLOAD);
		digest = Bun.SHA256.hash(PAYLOAD, "hex");
	});

	function checksums(lines: string[]): string {
		const path = join(
			root,
			`checksums-${lines.length}-${lines[0]?.length}.txt`,
		);
		writeFileSync(path, `${lines.join("\n")}\n`);
		return path;
	}

	function verify(path: string, name: string = ASSET): Result {
		return call(`verify "${assetPath}" "${name}" "${path}"`);
	}

	test("accepts a digest that matches, and says nothing", () => {
		const result = verify(checksums([`${digest}  ${ASSET}`]));
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	// The listing GitHub publishes carries every asset of the release, so the
	// right line has to be picked by name rather than by position.
	test("picks its own line out of the full release listing", () => {
		const result = verify(
			checksums([
				`${"a".repeat(64)}  cortex-v9.9.9-darwin-arm64.tar.gz`,
				`${digest}  ${ASSET}`,
				`${"b".repeat(64)}  cortex-v9.9.9-linux-arm64.tar.gz`,
			]),
		);
		expect(result.code).toBe(0);
	});

	test("refuses a digest that does not match, naming both", () => {
		const wrong = "0".repeat(64);
		const result = verify(checksums([`${wrong}  ${ASSET}`]));
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(`checksum mismatch for ${ASSET}`);
		expect(result.stderr).toContain(`expected ${wrong}`);
		expect(result.stderr).toContain(`actual   ${digest}`);
	});

	// An asset absent from checksums.txt is an unverifiable download, not a
	// verified one: awk prints nothing and the empty expectation must not match
	// an empty actual.
	test("refuses an asset the listing does not mention", () => {
		const result = verify(
			checksums([`${digest}  cortex-v9.9.9-darwin-arm64.tar.gz`]),
		);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(`${ASSET} is not listed in checksums.txt`);
	});

	// A name that is a prefix of another asset's must not borrow its digest.
	test("does not match an asset name by prefix", () => {
		const result = verify(checksums([`${digest}  ${ASSET}.sig`]));
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("is not listed in checksums.txt");
	});
});

describe("install.sh sha256_of", () => {
	function digestWith(tools: string[]): Result {
		const only = join(root, `only-${tools.join("-") || "none"}`);
		mkdirSync(only, { recursive: true });
		for (const tool of tools) {
			writeFileSync(join(only, tool), `#!/bin/sh\nexec ${which(tool)} "$@"\n`);
			chmodSync(join(only, tool), 0o755);
		}
		return call(`sha256_of "${join(root, ASSET)}"`, {}, only);
	}

	test("falls back to shasum where sha256sum is absent", () => {
		const shasum = which("shasum");
		if (!shasum) return;
		const result = digestWith(["shasum", "cut"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(Bun.SHA256.hash(PAYLOAD, "hex"));
	});

	// Nothing here may degrade to "install it anyway": a host that cannot
	// compute a digest cannot check one.
	test("refuses to continue where neither tool exists", () => {
		const result = digestWith([]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("neither sha256sum nor shasum");
	});
});

describe("install.sh version resolution", () => {
	// The stub answers curl's -w '%{url_effective}' probe, which is how
	// latest_version reads the /releases/latest redirect without an API token.
	function withEffectiveUrl(url: string): Result {
		const only = join(root, "curl-stub");
		mkdirSync(only, { recursive: true });
		writeFileSync(
			join(only, "curl"),
			url ? `#!/bin/sh\necho '${url}'\n` : "#!/bin/sh\nexit 22\n",
		);
		chmodSync(join(only, "curl"), 0o755);
		return call("latest_version", {}, `${only}:${process.env.PATH ?? ""}`);
	}

	test("reads the tag out of the redirect", () => {
		const result = withEffectiveUrl(
			"https://github.com/lucasreali/cortex-cli/releases/tag/v1.2.3",
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("v1.2.3");
	});

	test("says so when the redirect names no tag", () => {
		const result = withEffectiveUrl(
			"https://github.com/lucasreali/cortex-cli/releases",
		);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("no published release found");
	});

	test("says so when the request fails", () => {
		const result = withEffectiveUrl("");
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("could not reach");
	});

	test("a pinned version gains the v it is missing", () => {
		expect(call("resolve_version", { CORTEX_VERSION: "1.2.3" }).stdout).toBe(
			"v1.2.3",
		);
		expect(call("resolve_version", { CORTEX_VERSION: "v1.2.3" }).stdout).toBe(
			"v1.2.3",
		);
	});
});
