import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const CI = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/release.yml";

interface Step {
	name?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
}

interface Job {
	uses?: string;
	needs?: string | string[];
	permissions?: Record<string, string>;
	steps?: Step[];
}

interface Workflow {
	on: Record<string, unknown>;
	jobs: Record<string, Job>;
}

async function workflow(file: string): Promise<Workflow> {
	return Bun.YAML.parse(await Bun.file(join(ROOT, file)).text()) as Workflow;
}

let ci: Workflow;
let release: Workflow;

beforeAll(async () => {
	ci = await workflow(CI);
	release = await workflow(RELEASE);
});

function steps(job: Job): Step[] {
	return job.steps ?? [];
}

function script(job: Job): string {
	return steps(job)
		.map((step) => `${step.name ?? ""}\n${step.run ?? ""}`)
		.join("\n");
}

describe("the release runs the same gate a branch runs", () => {
	test("ci.yml is callable", async () => {
		expect(Object.hasOwn(ci.on, "workflow_call")).toBe(true);
	});

	// The finding this replaces: release.yml restated a subset of ci.yml —
	// typecheck, bun test, smoke — with no lint, no coverage threshold, no
	// coverage audit and no install.sh/target.ts agreement check. Naming the
	// workflow instead of its steps is what keeps the two from diverging again.
	test("release.yml calls ci.yml rather than restating its steps", async () => {
		expect(release.jobs.gate?.uses).toBe(`./${CI}`);
		expect(script(release.jobs.release ?? {})).not.toContain("typecheck");
	});

	test("nothing is published before that gate passes", async () => {
		expect(release.jobs.gate?.needs).toBe("tag");
		expect(release.jobs.release?.needs).toBe("gate");
		expect(release.jobs["verify-darwin"]?.needs).toBe("release");
	});

	test("the tag is still asserted against package.json", async () => {
		expect(script(release.jobs.tag ?? {})).toContain(
			"tag $tag != package.json $pkg",
		);
	});
});

describe("what is published is what was proven", () => {
	// The gate compiles its own binary from the same source; that is not the
	// same claim as "these bytes run".
	test("the release job smoke-tests the unpacked tarball", async () => {
		const published = script(release.jobs.release ?? {});
		expect(published).toContain("CORTEX_SMOKE_BINARY=");
		expect(published).toContain("bun run smoke:compiled");
	});

	test("it also proves the notices travel inside the tarball", async () => {
		const published = script(release.jobs.release ?? {});
		expect(published).toContain("LICENSE");
		expect(published).toContain("THIRD-PARTY-NOTICES.md");
	});

	// checksums.txt is served by the origin it verifies, so it detects
	// corruption and not substitution. The attestation is the second root.
	test("every asset is attested, and the attestation is verified", async () => {
		const attest = steps(release.jobs.release ?? {}).find((step) =>
			step.uses?.startsWith("actions/attest-build-provenance@"),
		);
		expect(attest).toBeDefined();
		expect(release.jobs.release?.permissions).toMatchObject({
			"id-token": "write",
			attestations: "write",
		});
		expect(script(release.jobs["verify-darwin"] ?? {})).toContain(
			"gh attestation verify",
		);
	});
});
