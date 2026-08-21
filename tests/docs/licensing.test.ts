import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

async function read(file: string): Promise<string> {
	return Bun.file(join(ROOT, file)).text();
}

describe("the repository states its own license", () => {
	test("LICENSE is present and is the MIT text", async () => {
		const license = await read("LICENSE");
		expect(license.split("\n")[0]).toBe("MIT License");
		expect(license).toContain("Copyright (c) 2026 Lucas Reali");
		expect(license).toContain("THE SOFTWARE IS PROVIDED");
	});

	test("package.json declares the same license", async () => {
		const manifest = await Bun.file(join(ROOT, "package.json")).json();
		expect(manifest.license).toBe("MIT");
	});

	// The dependency set is redistributed inside the binary, so the notices file
	// travels with it; the README is where a reader is told that before they
	// download a tarball.
	test("the README points at both", async () => {
		const readme = await read("README.md");
		expect(readme).toContain("## License");
		expect(readme).toContain("[LICENSE](LICENSE)");
		expect(readme).toContain("THIRD-PARTY-NOTICES.md");
	});
});
