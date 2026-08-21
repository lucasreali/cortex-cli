import { describe, expect, test } from "bun:test";
import type { McpServerSpec } from "@/install/server-spec";
import { CORTEX_TABLE_HEADER, upsertTomlTable } from "@/install/toml-mcp";

const SPEC: McpServerSpec = {
	command: "/home/user/.local/bin/cortex",
	args: ["serve", "--mcp"],
};

const BLOCK = `${CORTEX_TABLE_HEADER}\ncommand = "${SPEC.command}"\nargs = ["serve", "--mcp"]\n`;

function written(content: string): string {
	const result = upsertTomlTable(content, SPEC);
	if (!("content" in result)) throw new Error(`conflict: ${result.reason}`);
	return result.content;
}

function cortexEntry(content: string): unknown {
	const parsed = Bun.TOML.parse(content) as {
		mcp_servers?: { cortex?: unknown };
	};
	return parsed.mcp_servers?.cortex;
}

describe("upsertTomlTable", () => {
	test("an empty file gets just the block", () => {
		expect(upsertTomlTable("", SPEC)).toEqual({
			content: BLOCK,
			action: "inserted",
		});
	});

	test("a command with backslashes and quotes round-trips", () => {
		const command = 'C:\\Program Files\\"cortex"';
		const result = upsertTomlTable("", { command, args: [] });
		if (!("content" in result)) throw new Error("expected a write");
		expect(cortexEntry(result.content)).toEqual({ command, args: [] });
	});

	test("appends after a blank line, preserving existing content", () => {
		const existing = 'model = "gpt-5"\n\n[profiles.fast]\nspeed = 1\n';
		const result = upsertTomlTable(existing, SPEC);
		expect(result).toEqual({
			content: `${existing}\n${BLOCK}`,
			action: "inserted",
		});
	});

	test("adds a trailing newline before appending when missing", () => {
		expect(written('model = "gpt-5"')).toBe(`model = "gpt-5"\n\n${BLOCK}`);
	});

	test("replaces a stale table that sits between other tables", () => {
		const existing =
			'model = "gpt-5"\n\n[mcp_servers.cortex]\ncommand = "/old"\nargs = []\n\n[mcp_servers.other]\ncommand = "other"\n';
		const result = upsertTomlTable(existing, SPEC);
		expect(result).toEqual({
			content: `model = "gpt-5"\n\n${BLOCK}\n[mcp_servers.other]\ncommand = "other"\n`,
			action: "replaced",
		});
	});

	test("replaces a stale table at the end of the file", () => {
		const result = upsertTomlTable(
			'[mcp_servers.cortex]\ncommand = "/old"',
			SPEC,
		);
		expect(result).toEqual({ content: BLOCK, action: "replaced" });
	});

	test("an entry that already matches is unchanged", () => {
		const existing = `# managed\n${BLOCK}\n[other]\nx = 1\n`;
		expect(upsertTomlTable(existing, SPEC)).toEqual({
			content: existing,
			action: "unchanged",
		});
	});

	test("a header mentioned mid-line is not mistaken for the table", () => {
		const existing = '# see [mcp_servers.cortex] below\nmodel = "gpt-5"\n';
		expect(written(existing)).toBe(`${existing}\n${BLOCK}`);
	});
});

// M32: found by exact whole-line search, every one of these missed and the
// block was appended a second time — which is not a duplicate entry, it is a
// config.toml that stops parsing, taking every other MCP server with it.
describe("near-miss headers are the same table, never a second definition", () => {
	const spellings = [
		"[mcp_servers.cortex] ",
		"  [mcp_servers.cortex]",
		"[ mcp_servers.cortex ]",
		"[mcp_servers . cortex]",
		'[mcp_servers."cortex"]',
		"[mcp_servers.'cortex']",
		'["mcp_servers".cortex]',
		"[mcp_servers.cortex] # ours",
	];

	for (const header of spellings) {
		test(`${header.trim()} is rewritten, not duplicated`, () => {
			const content = written(`${header}\ncommand = "/old"\nargs = []\n`);
			expect(() => Bun.TOML.parse(content)).not.toThrow();
			expect(cortexEntry(content)).toEqual({
				command: SPEC.command,
				args: [...SPEC.args],
			});
			expect(content.match(/mcp_servers\.cortex/g)).toHaveLength(1);
		});
	}

	test("a matching entry under a near-miss header is left alone", () => {
		const existing = `[ mcp_servers.cortex ]\ncommand = "${SPEC.command}"\nargs = ["serve", "--mcp"]\n`;
		expect(upsertTomlTable(existing, SPEC)).toEqual({
			content: existing,
			action: "unchanged",
		});
	});

	test("a sibling server's table is not mistaken for ours", () => {
		const existing = '[mcp_servers.other]\ncommand = "other"\n';
		const content = written(existing);
		expect(cortexEntry(content)).toEqual({
			command: SPEC.command,
			args: [...SPEC.args],
		});
		expect(content).toContain('[mcp_servers.other]\ncommand = "other"');
	});
});

describe("shapes cortex refuses rather than corrupts", () => {
	test("a file that is already not valid TOML is left untouched", () => {
		const result = upsertTomlTable("[unclosed\nmodel = 1", SPEC);
		expect(result).toEqual({
			action: "conflict",
			reason: expect.stringContaining("not valid TOML"),
		});
	});

	test("an inline mcp_servers table cannot be extended with a header", () => {
		const result = upsertTomlTable(
			'mcp_servers = { cortex = { command = "/old" } }\n',
			SPEC,
		);
		expect(result).toEqual({
			action: "conflict",
			reason: expect.stringContaining("cannot"),
		});
	});

	test("a dotted root key defining the entry is refused", () => {
		const result = upsertTomlTable(
			'mcp_servers.cortex.command = "/old"\n',
			SPEC,
		);
		expect(result.action).toBe("conflict");
	});

	test("mcp_servers defined as a scalar is refused", () => {
		expect(upsertTomlTable("mcp_servers = 5\n", SPEC).action).toBe("conflict");
	});

	test("an array-of-tables definition is refused", () => {
		const result = upsertTomlTable(
			'[[mcp_servers.cortex]]\ncommand = "/old"\n',
			SPEC,
		);
		expect(result.action).toBe("conflict");
	});

	test("a key with an escape this locator does not read is refused, not duplicated", () => {
		const result = upsertTomlTable(
			'[mcp_servers."cor\\u0074ex"]\ncommand = "/old"\n',
			SPEC,
		);
		expect(result.action).toBe("conflict");
	});
});

// M35: replacing the entry wholesale silently deleted keys the user added,
// bringing back the very behaviour they were suppressing.
describe("user-added keys on the cortex entry survive", () => {
	test("an env sub-table is kept and re-rendered", () => {
		const existing =
			'[mcp_servers.cortex]\ncommand = "/old"\nargs = []\n\n[mcp_servers.cortex.env]\nCORTEX_NO_USEFULNESS = "1"\n';
		const content = written(existing);
		expect(cortexEntry(content)).toEqual({
			command: SPEC.command,
			args: [...SPEC.args],
			env: { CORTEX_NO_USEFULNESS: "1" },
		});
		expect(content.match(/\[mcp_servers\.cortex\.env\]/g)).toHaveLength(1);
	});

	test("a scalar key the installer does not manage is kept", () => {
		const content = written(
			'[mcp_servers.cortex]\ncommand = "/old"\nstartup_timeout_ms = 30000\n',
		);
		expect(cortexEntry(content)).toEqual({
			command: SPEC.command,
			args: [...SPEC.args],
			startup_timeout_ms: 30000,
		});
	});

	test("an entry that only differs in a kept key is unchanged", () => {
		const content = written(
			'[mcp_servers.cortex]\ncommand = "/old"\nkeep = true\n',
		);
		expect(upsertTomlTable(content, SPEC)).toEqual({
			content,
			action: "unchanged",
		});
	});

	test("a following unrelated table survives the sub-table splice", () => {
		const content = written(
			'[mcp_servers.cortex]\ncommand = "/old"\n\n[mcp_servers.cortex.env]\nA = "1"\n\n[profiles.fast]\nspeed = 1\n',
		);
		const parsed = Bun.TOML.parse(content) as { profiles?: unknown };
		expect(parsed.profiles).toEqual({ fast: { speed: 1 } });
	});
});
