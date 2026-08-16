import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomically, writeAtomicallySync } from "@/support/atomic-write";

type Writer = {
	name: string;
	write: (path: string, source: string) => Promise<void>;
};

const WRITERS: Writer[] = [
	{ name: "writeAtomically", write: writeAtomically },
	{
		name: "writeAtomicallySync",
		write: async (path, source) => writeAtomicallySync(path, source),
	},
];

function scratchDirectory(): string {
	return mkdtempSync(join(tmpdir(), "cortex-atomic-"));
}

function permissions(path: string): number {
	return statSync(path).mode & 0o777;
}

for (const writer of WRITERS) {
	describe(writer.name, () => {
		test("publishes the file under its final name with nothing left staged", async () => {
			const directory = scratchDirectory();
			const target = join(directory, "asset.bin");
			await writer.write(target, "payload");
			expect(readFileSync(target, "utf8")).toBe("payload");
			expect(readdirSync(directory)).toEqual(["asset.bin"]);
		});

		test("replaces an existing file in place", async () => {
			const directory = scratchDirectory();
			const target = join(directory, "asset.bin");
			await writer.write(target, "first");
			await writer.write(target, "second");
			expect(readFileSync(target, "utf8")).toBe("second");
			expect(readdirSync(directory)).toEqual(["asset.bin"]);
		});

		test("writes through a symlink and stages beside the real target", async () => {
			const directory = scratchDirectory();
			const store = join(directory, "store");
			const links = join(directory, "links");
			mkdirSync(store);
			mkdirSync(links);
			const real = join(store, "asset.bin");
			const link = join(links, "asset.bin");
			writeFileSync(real, "first");
			symlinkSync(real, link);

			await writer.write(link, "second");

			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readFileSync(real, "utf8")).toBe("second");
			expect(readdirSync(links)).toEqual(["asset.bin"]);
			expect(readdirSync(store)).toEqual(["asset.bin"]);
		});

		test("follows a chain of symlinks to the file at its end", async () => {
			const directory = scratchDirectory();
			const real = join(directory, "asset.bin");
			const middle = join(directory, "middle.link");
			const entry = join(directory, "entry.link");
			writeFileSync(real, "first");
			symlinkSync(real, middle);
			symlinkSync(middle, entry);

			await writer.write(entry, "second");

			expect(lstatSync(entry).isSymbolicLink()).toBe(true);
			expect(lstatSync(middle).isSymbolicLink()).toBe(true);
			expect(readFileSync(real, "utf8")).toBe("second");
		});

		test("creates the target a dangling symlink points at", async () => {
			const directory = scratchDirectory();
			const missing = join(directory, "missing.bin");
			const link = join(directory, "asset.bin");
			symlinkSync(missing, link);

			await writer.write(link, "payload");

			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readFileSync(missing, "utf8")).toBe("payload");
		});

		test("resolves a relative symlink against its own directory", async () => {
			const directory = scratchDirectory();
			const real = join(directory, "asset.bin");
			const link = join(directory, "asset.link");
			writeFileSync(real, "first");
			symlinkSync("asset.bin", link);

			await writer.write(link, "second");

			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readFileSync(real, "utf8")).toBe("second");
		});

		test("gives up on a symlink cycle instead of spinning", async () => {
			const directory = scratchDirectory();
			const first = join(directory, "first.link");
			const second = join(directory, "second.link");
			symlinkSync(second, first);
			symlinkSync(first, second);

			await writer.write(first, "payload");

			expect(readFileSync(first, "utf8")).toBe("payload");
		});

		test("keeps the mode a destination already had", async () => {
			const directory = scratchDirectory();
			const target = join(directory, "asset.bin");
			writeFileSync(target, "first");
			chmodSync(target, 0o664);

			await writer.write(target, "second");

			expect(permissions(target)).toBe(0o664);
			expect(readFileSync(target, "utf8")).toBe("second");
		});

		test("keeps the mode of the file a symlink points at", async () => {
			const directory = scratchDirectory();
			const real = join(directory, "asset.bin");
			const link = join(directory, "asset.link");
			writeFileSync(real, "first");
			chmodSync(real, 0o750);
			symlinkSync(real, link);

			await writer.write(link, "second");

			expect(permissions(real)).toBe(0o750);
		});

		test("leaves a new file to the umask instead of inventing a mode", async () => {
			const directory = scratchDirectory();
			const target = join(directory, "asset.bin");
			const reference = join(directory, "reference.bin");
			writeFileSync(reference, "reference");

			await writer.write(target, "payload");

			expect(permissions(target)).toBe(permissions(reference));
		});
	});
}
