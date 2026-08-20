import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { seedDecision } from "@tests/support/seed";
import { openDecisionsDb } from "@/storage/connection";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { callTool, connect, makeProject } from "./harness";

// One more than the answer's cap, so the marker has something to report.
const DEPENDENTS = 101;

let dir: string;
let client: Client;
let rootId: string;

beforeAll(async () => {
	dir = makeProject("cortex-impact-size-", "git@github.com:acme/wide.git");
	rootId = seedWideGraph(join(dir, ".cortex"));
	client = await connect(dir);
}, 60_000);

afterAll(async () => {
	await client?.close();
	rmSync(dir, { recursive: true, force: true });
});

function seedWideGraph(cortexDir: string): string {
	const db = openDecisionsDb(cortexDir);
	try {
		migrate(db);
		const nodes = new NodeRepository(db);
		const projectId = nodes.ensureProject("github.com/acme/wide");
		const context: SaveContext = {
			projectId,
			sessionId: nodes.createSession(projectId),
			commitSha: null,
			commitDirty: false,
		};
		const root = seedDecision(cortexDir, db, decision("Decisão raiz"), context);
		for (let index = 0; index < DEPENDENTS; index += 1) {
			seedDecision(
				cortexDir,
				db,
				{
					...decision(`Decisão dependente ${index}`),
					depends_on: [root.id],
				},
				context,
			);
		}
		return root.id;
	} finally {
		db.close();
	}
}

function decision(title: string) {
	return {
		title,
		body: "Corpo suficientemente longo para o schema de decisão passar.",
		keywords: ["auth", "jwt", "token", "login", "sessão"],
	};
}

describe("get_impact on a decision with a wide blast radius", () => {
	test("caps the answer and says how much it left out", async () => {
		const { isError, payload, message } = await callTool(client, "get_impact", {
			decision_id: rootId,
		});

		expect(isError).toBe(false);
		expect(payload.impacted).toHaveLength(100);
		expect(payload.truncated).toEqual({
			shown_per_lens: 100,
			omitted: DEPENDENTS - 100,
			guidance: expect.any(String),
		});
		expect(message.length).toBeLessThan(200_000);
	});
});
