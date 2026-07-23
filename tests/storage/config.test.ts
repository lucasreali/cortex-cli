import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "@/storage/config";

function makeCortexDir(): string {
	return mkdtempSync(join(tmpdir(), "cortex-config-"));
}

describe("cortex config", () => {
	test("write/read round-trips the pinned model and schema version", async () => {
		const dir = makeCortexDir();
		await writeConfig(dir, { model_id: "model@1", schema_version: 1 });
		expect(await readConfig(dir)).toEqual({
			model_id: "model@1",
			schema_version: 1,
		});
	});

	test("a missing config reads as null", async () => {
		expect(await readConfig(makeCortexDir())).toBeNull();
	});

	test("a corrupt config reads as null instead of throwing", async () => {
		const dir = makeCortexDir();
		await Bun.write(join(dir, "config"), "{not valid json");
		expect(await readConfig(dir)).toBeNull();
	});
});
