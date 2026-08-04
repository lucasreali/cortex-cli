import { describe, expect, test } from "bun:test";
import {
	buildCortexTable,
	CORTEX_TABLE_HEADER,
	upsertTomlTable,
} from "@/install/toml-mcp";

const BLOCK = buildCortexTable({
	command: "/home/user/.local/bin/cortex",
	args: ["serve", "--mcp"],
});

describe("buildCortexTable", () => {
	test("renders the table with quoted command and args", () => {
		expect(BLOCK).toBe(
			'[mcp_servers.cortex]\ncommand = "/home/user/.local/bin/cortex"\nargs = ["serve", "--mcp"]\n',
		);
	});

	test("escapes backslashes and quotes in values", () => {
		const table = buildCortexTable({
			command: 'C:\\Program Files\\"cortex"',
			args: [],
		});
		expect(table).toContain('command = "C:\\\\Program Files\\\\\\"cortex\\""');
	});
});

describe("upsertTomlTable", () => {
	test("an empty file gets just the block", () => {
		expect(upsertTomlTable("", CORTEX_TABLE_HEADER, BLOCK)).toEqual({
			content: BLOCK,
			action: "inserted",
		});
	});

	test("appends after a blank line, preserving existing content", () => {
		const existing = 'model = "gpt-5"\n\n[profiles.fast]\nspeed = 1\n';
		const result = upsertTomlTable(existing, CORTEX_TABLE_HEADER, BLOCK);
		expect(result.action).toBe("inserted");
		expect(result.content).toBe(`${existing}\n${BLOCK}`);
	});

	test("adds a trailing newline before appending when missing", () => {
		const result = upsertTomlTable(
			'model = "gpt-5"',
			CORTEX_TABLE_HEADER,
			BLOCK,
		);
		expect(result.content).toBe(`model = "gpt-5"\n\n${BLOCK}`);
	});

	test("replaces a stale table that sits between other tables", () => {
		const existing =
			'model = "gpt-5"\n\n[mcp_servers.cortex]\ncommand = "/old"\nargs = []\n\n[mcp_servers.other]\ncommand = "other"\n';
		const result = upsertTomlTable(existing, CORTEX_TABLE_HEADER, BLOCK);
		expect(result.action).toBe("replaced");
		expect(result.content).toBe(
			`model = "gpt-5"\n\n${BLOCK}\n[mcp_servers.other]\ncommand = "other"\n`,
		);
	});

	test("replaces a stale table at the end of the file", () => {
		const existing = '[mcp_servers.cortex]\ncommand = "/old"';
		const result = upsertTomlTable(existing, CORTEX_TABLE_HEADER, BLOCK);
		expect(result.action).toBe("replaced");
		expect(result.content).toBe(BLOCK);
	});

	test("a byte-identical table is unchanged", () => {
		const existing = `# managed\n${BLOCK}\n[other]\nx = 1\n`;
		const result = upsertTomlTable(existing, CORTEX_TABLE_HEADER, BLOCK);
		expect(result.action).toBe("unchanged");
		expect(result.content).toBe(existing);
	});

	test("a header mentioned mid-line is not mistaken for the table", () => {
		const existing = '# see [mcp_servers.cortex] below\nmodel = "gpt-5"\n';
		const result = upsertTomlTable(existing, CORTEX_TABLE_HEADER, BLOCK);
		expect(result.action).toBe("inserted");
		expect(result.content).toBe(`${existing}\n${BLOCK}`);
	});
});
