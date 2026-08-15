import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	CLI_PATH,
	callTool as callToolOn,
	connect,
	makeTempDir,
	run as runIn,
} from "./harness";

let dir: string;
let client: Client;
let decisionId: string;

async function callTool(name: string, args: Record<string, unknown>) {
	return callToolOn(client, name, args);
}

interface AnchorPayload {
	filePath: string;
	symbol: string;
	confidence: string;
}

beforeAll(async () => {
	dir = makeTempDir("cortex-anchor-confidence-mcp-");
	runIn(dir, "git", "init", "-b", "main");
	runIn(
		dir,
		"git",
		"remote",
		"add",
		"origin",
		"git@github.com:acme/anchors.git",
	);
	mkdirSync(join(dir, "src/auth"), { recursive: true });
	writeFileSync(
		join(dir, "src/auth/service.ts"),
		"export class AuthService {\n\tvalidateToken(token: string) {\n\t\treturn token.length > 0;\n\t}\n}\n",
	);
	writeFileSync(join(dir, "install.sh"), "#!/bin/sh\ndetect_suffix() { :; }\n");
	runIn(dir, "bun", CLI_PATH, "init", "--yes");
	client = await connect(dir);

	const saved = await callTool("save_decision", {
		title: "Validação de token centralizada no AuthService",
		body: "Toda validação de token passa pelo método validateToken do serviço.",
		keywords: ["token", "validação", "validation", "auth", "service"],
		module: "auth",
		anchors: [
			{
				file_path: "src/auth/service.ts",
				symbol: "AuthService.validateToken",
			},
			{ file_path: "install.sh" },
			{ file_path: "src/auth/gone.ts" },
		],
	});
	decisionId = saved.payload.id;
}, 30_000);

afterAll(async () => {
	await client?.close();
	rmSync(dir, { recursive: true, force: true });
});

function confidenceByPath(anchors: AnchorPayload[]): Record<string, string> {
	return Object.fromEntries(
		anchors.map((anchor) => [anchor.filePath, anchor.confidence]),
	);
}

const EXPECTED = {
	"src/auth/service.ts": "exact",
	"install.sh": "file_only",
	"src/auth/gone.ts": "unresolved",
};

describe("anchor confidence over MCP", () => {
	test("get_impact grades the anchors of the decision it reports", async () => {
		const { payload } = await callTool("get_impact", {
			decision_id: decisionId,
		});
		expect(confidenceByPath(payload.decision.anchors)).toEqual(EXPECTED);
	});

	test("get_context carries the same grades when browsing", async () => {
		const { payload } = await callTool("get_context", {});
		expect(confidenceByPath(payload.decisions[0].anchors)).toEqual(EXPECTED);
	});

	test("get_context carries them on the intent path too", async () => {
		const { payload } = await callTool("get_context", {
			intent: "como validamos token?",
		});
		expect(confidenceByPath(payload.decisions[0].anchors)).toEqual(EXPECTED);
	});
});
