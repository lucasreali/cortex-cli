import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMMA_MODEL } from "@/embedding/model";
import {
	embedDeadlineMs,
	MODEL_ACQUISITION_TIMEOUT_MS,
	markModelResident,
	modelCacheDirectory,
	modelIsResident,
} from "@/embedding/model-cache";

const directories: string[] = [];

function makeModelsDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "cortex-models-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		chmodSync(directory, 0o700);
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("model residency", () => {
	test("an empty models directory holds no resident model", () => {
		expect(modelIsResident(makeModelsDir())).toBe(false);
	});

	// A download creates the cache directory before the first byte lands, so
	// the directory alone can never stand in for a finished model.
	test("a cache directory without the marker is not residency", () => {
		const directory = makeModelsDir();
		Bun.write(join(modelCacheDirectory(directory), "config.json"), "{}");
		expect(modelIsResident(directory)).toBe(false);
	});

	test("marking makes the model resident and names the model it is", async () => {
		const directory = makeModelsDir();
		markModelResident(directory);
		expect(modelIsResident(directory)).toBe(true);
		const marker = join(
			modelCacheDirectory(directory),
			".cortex-model-resident",
		);
		expect(await Bun.file(marker).text()).toContain(GEMMA_MODEL.modelId);
	});

	test("a models directory that cannot be written costs nothing", () => {
		const directory = makeModelsDir();
		chmodSync(directory, 0o500);
		expect(() => markModelResident(directory)).not.toThrow();
		expect(modelIsResident(directory)).toBe(false);
		expect(existsSync(modelCacheDirectory(directory))).toBe(false);
	});
});

describe("embedDeadlineMs", () => {
	test("a resident model is embedded under the configured deadline", () => {
		expect(embedDeadlineMs({ modelResident: () => true }, 30_000)).toBe(30_000);
	});

	// The whole of B6: the 30 s that catches a wedged worker must not be the
	// budget a 300 MB download has to finish inside.
	test("a model still to be fetched gets the acquisition budget", () => {
		expect(embedDeadlineMs({ modelResident: () => false }, 30_000)).toBe(
			MODEL_ACQUISITION_TIMEOUT_MS,
		);
	});

	test("a deadline longer than the acquisition budget is kept", () => {
		const longer = MODEL_ACQUISITION_TIMEOUT_MS + 1000;
		expect(embedDeadlineMs({ modelResident: () => false }, longer)).toBe(
			longer,
		);
	});

	test("a provider that cannot say is taken at the configured deadline", () => {
		expect(embedDeadlineMs({}, 50)).toBe(50);
	});
});
