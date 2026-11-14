import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMMA_MODEL } from "@/embedding/model";
import {
	embedDeadlineMs,
	MODEL_ACQUISITION_TIMEOUT_MS,
	markModelResident,
	modelCacheDirectory,
	modelIsResident,
	withModelAcquisition,
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
	test("a cache directory without the marker is not residency", async () => {
		const directory = makeModelsDir();
		await Bun.write(join(modelCacheDirectory(directory), "config.json"), "{}");
		expect(modelIsResident(directory)).toBe(false);
	});

	test("marking makes the model resident and names the model it is", async () => {
		const directory = makeModelsDir();
		markModelResident(directory);
		expect(modelIsResident(directory)).toBe(true);
		const marker = join(
			modelCacheDirectory(directory),
			`.cortex-model-resident-${GEMMA_MODEL.revision.slice(0, 12)}`,
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

describe("withModelAcquisition", () => {
	test("a resident model loads without touching the lock", async () => {
		const directory = makeModelsDir();
		markModelResident(directory);
		expect(
			await withModelAcquisition(async () => "loaded", { directory }),
		).toBe("loaded");
		expect(readdirSync(directory)).not.toContain(".cortex-model-download.lock");
	});

	test("holds the lock while loading and releases it after", async () => {
		const directory = makeModelsDir();
		const lockPath = join(directory, ".cortex-model-download.lock");
		const seen = await withModelAcquisition(async () => existsSync(lockPath), {
			directory,
		});
		expect(seen).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
	});

	test("waits on a live holder until the model turns resident", async () => {
		const directory = makeModelsDir();
		const lockPath = join(directory, ".cortex-model-download.lock");
		writeFileSync(lockPath, String(process.pid));
		setTimeout(() => markModelResident(directory), 30);

		expect(
			await withModelAcquisition(async () => "from cache", {
				directory,
				pid: process.pid + 1,
				pollMs: 10,
			}),
		).toBe("from cache");
		expect(existsSync(lockPath)).toBe(true);
	});

	test("gives up waiting at the deadline and loads anyway", async () => {
		const directory = makeModelsDir();
		writeFileSync(
			join(directory, ".cortex-model-download.lock"),
			String(process.pid),
		);
		expect(
			await withModelAcquisition(async () => "loaded", {
				directory,
				pid: process.pid + 1,
				pollMs: 5,
				deadlineMs: 20,
			}),
		).toBe("loaded");
	});

	test("takes over a lock whose holder died", async () => {
		const directory = makeModelsDir();
		const lockPath = join(directory, ".cortex-model-download.lock");
		writeFileSync(lockPath, "not-a-pid");
		const holder = await withModelAcquisition(
			async () => readFileSync(lockPath, "utf8"),
			{ directory, pollMs: 1 },
		);
		expect(holder).toBe(String(process.pid));
	});

	test("a lock removed while loading is not an error", async () => {
		const directory = makeModelsDir();
		const lockPath = join(directory, ".cortex-model-download.lock");
		expect(
			await withModelAcquisition(
				async () => {
					rmSync(lockPath);
					return "loaded";
				},
				{ directory },
			),
		).toBe("loaded");
	});

	test("a models directory that cannot hold a lock still loads", async () => {
		const parent = makeModelsDir();
		const directory = join(parent, "is-a-file");
		writeFileSync(directory, "");
		expect(
			await withModelAcquisition(async () => "loaded", { directory }),
		).toBe("loaded");
	});

	test("a lock it can neither read nor remove is waited out", async () => {
		const directory = makeModelsDir();
		mkdirSync(join(directory, ".cortex-model-download.lock"));
		expect(
			await withModelAcquisition(async () => "loaded", {
				directory,
				pollMs: 5,
				deadlineMs: 20,
			}),
		).toBe("loaded");
	});
});
