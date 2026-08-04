import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertJsonMcpServer } from "@/install/json-mcp";

const ENTRY = { type: "stdio", command: "cortex", args: ["serve", "--mcp"] };

function configPath(): string {
	return join(
		mkdtempSync(join(tmpdir(), "cortex-json-mcp-")),
		"nested",
		"mcp.json",
	);
}

describe("upsertJsonMcpServer", () => {
	test("creates the file and parent directory when missing", async () => {
		const path = configPath();
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome).toEqual({ path, action: "created" });
		expect(await Bun.file(path).json()).toEqual({
			mcpServers: { cortex: ENTRY },
		});
	});

	test("preserves sibling servers and unrelated keys", async () => {
		const path = configPath();
		const existing = {
			theme: "dark",
			mcpServers: { other: { command: "other" } },
		};
		await Bun.write(path, JSON.stringify(existing));
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("updated");
		expect(await Bun.file(path).json()).toEqual({
			theme: "dark",
			mcpServers: { other: { command: "other" }, cortex: ENTRY },
		});
	});

	test("an identical entry is reported unchanged without rewriting", async () => {
		const path = configPath();
		const text = `{"mcpServers":{"cortex":${JSON.stringify(ENTRY)}}}`;
		await Bun.write(path, text);
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("unchanged");
		expect(await Bun.file(path).text()).toBe(text);
	});

	test("a stale entry is updated in place", async () => {
		const path = configPath();
		await Bun.write(
			path,
			JSON.stringify({ mcpServers: { cortex: { command: "/old/cortex" } } }),
		);
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("updated");
		const parsed = (await Bun.file(path).json()) as {
			mcpServers: { cortex: unknown };
		};
		expect(parsed.mcpServers.cortex).toEqual(ENTRY);
	});

	test("an empty file is treated as an empty config", async () => {
		const path = configPath();
		await Bun.write(path, "");
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("updated");
		expect(await Bun.file(path).json()).toEqual({
			mcpServers: { cortex: ENTRY },
		});
	});

	test("unparseable JSON is skipped and left untouched", async () => {
		const path = configPath();
		await Bun.write(path, "{not json");
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("skipped-unreadable");
		expect(await Bun.file(path).text()).toBe("{not json");
	});

	test("a non-object root is skipped", async () => {
		const path = configPath();
		await Bun.write(path, "[1, 2]");
		expect((await upsertJsonMcpServer(path, ENTRY)).action).toBe(
			"skipped-unreadable",
		);
	});

	test("a non-object mcpServers is skipped", async () => {
		const path = configPath();
		await Bun.write(path, '{"mcpServers": "oops"}');
		expect((await upsertJsonMcpServer(path, ENTRY)).action).toBe(
			"skipped-unreadable",
		);
	});
});
