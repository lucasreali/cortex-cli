// Every release tarball carries the license text of the code inside the binary
// it ships. The list is derived from the compiled bundle rather than from
// package.json, because a dependency graph over-lists — 149 packages install
// here, 12 reach the binary — and a hand-kept list under-lists the first time
// an import changes.
import { join } from "node:path";

export interface PackageNotice {
	name: string;
	license: string;
	text: string;
}

const PACKAGE_IN_PATH = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//;
const ASSET_IMPORT = /\bfrom\s+"[^"]*node_modules\/((?:@[^/"]+\/)?[^/"]+)\//g;
const LICENSE_FILE = /^(?:licen[cs]e|notice|copying)(?:[.-].*)?$/i;

// The bundler emits one `sources` entry per file it inlined, so the packages
// named there are the ones whose code is in the binary. An asset is copied
// whole instead of parsed — onnxruntime-web's WASM backend, the tree-sitter
// grammar — and leaves no entry, so the packages reached by a `type: "file"`
// import are read off this repo's own sources.
export function bundledPackages(
	sourcemap: string,
	repositorySources: string,
): string[] {
	const names = new Set([
		...packagesInSourcemap(sourcemap),
		...packagesImportedAsAssets(repositorySources),
	]);
	return [...names].sort();
}

function packagesInSourcemap(sourcemap: string): string[] {
	const sources = JSON.parse(sourcemap).sources as unknown;
	if (!Array.isArray(sources)) {
		throw new Error("the bundle sourcemap has no sources array");
	}
	return sources
		.map((source) => PACKAGE_IN_PATH.exec(String(source))?.[1])
		.filter((name) => name !== undefined);
}

function packagesImportedAsAssets(repositorySources: string): string[] {
	return [...repositorySources.matchAll(ASSET_IMPORT)]
		.map((match) => match[1])
		.filter((name) => name !== undefined);
}

// A package that declares a license but ships no text is not a package we may
// redistribute quietly: the text lives under scripts/licenses/ instead, which
// makes vendoring it a reviewed act rather than a silent omission.
export async function readNotice(
	name: string,
	modulesDirectory: string,
	fallbackDirectory: string,
): Promise<PackageNotice> {
	const packageDirectory = join(modulesDirectory, name);
	const manifest = await Bun.file(
		join(packageDirectory, "package.json"),
	).json();
	const shipped = await licenseInPackage(packageDirectory);
	const text = shipped ?? (await vendoredLicense(name, fallbackDirectory));
	return { name, license: String(manifest.license ?? "UNDECLARED"), text };
}

async function licenseInPackage(directory: string): Promise<string | null> {
	const entries = await Array.fromAsync(new Bun.Glob("*").scan(directory));
	const files = entries.filter((entry) => LICENSE_FILE.test(entry)).sort();
	const texts = await Promise.all(
		files.map((file) => Bun.file(join(directory, file)).text()),
	);
	return texts.length === 0 ? null : texts.join("\n").trim();
}

async function vendoredLicense(
	name: string,
	fallbackDirectory: string,
): Promise<string> {
	const file = Bun.file(join(fallbackDirectory, `${vendoredName(name)}.txt`));
	if (await file.exists()) return (await file.text()).trim();
	throw new Error(
		`${name} ships no license text and none is vendored at ` +
			`scripts/licenses/${vendoredName(name)}.txt`,
	);
}

function vendoredName(name: string): string {
	return name.replace("/", "__");
}

export function renderNotices(
	version: string,
	notices: PackageNotice[],
): string {
	return `${[preamble(version), ...notices.map(section)].join("\n\n")}\n`;
}

function preamble(version: string): string {
	return `# Third-party notices — cortex ${version}

cortex is distributed as a single compiled binary with its dependencies
bundled into it. The packages below are the ones whose code is inside that
binary, listed with the license each of them is redistributed under. cortex
itself is MIT; see the LICENSE file shipped beside this one.

This file is generated from the compiled bundle at packaging time, so it
describes exactly the binary it travels with.`;
}

function section(notice: PackageNotice): string {
	return `---

## ${notice.name} — ${notice.license}

\`\`\`
${notice.text}
\`\`\``;
}
