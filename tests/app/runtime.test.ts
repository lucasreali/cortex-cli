import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime } from "@/app/runtime";

function makeProjectDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "cortex-runtime-")));
}

describe("buildRuntime", () => {
	test("outside a git repo it roots the store at the given directory", async () => {
		const dir = makeProjectDir();
		const runtime = await buildRuntime(dir);
		try {
			expect(runtime.repoRoot).toBe(dir);
			expect(runtime.cortexDir).toBe(join(dir, ".cortex"));
		} finally {
			runtime.dispose();
		}
	});

	test("ensureSession reuses one session; saveContext carries it without git", async () => {
		const runtime = await buildRuntime(makeProjectDir());
		try {
			const session = runtime.ensureSession();
			expect(runtime.ensureSession()).toBe(session);

			const context = runtime.saveContext();
			expect(context).toEqual({
				projectId: runtime.projectNodeId,
				sessionId: session,
				commitSha: null,
				commitDirty: false,
			});
		} finally {
			runtime.dispose();
		}
	});
});
