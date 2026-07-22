import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symbolHint } from "@/app/symbol-hints";
import { CodeRepository } from "@/storage/code-repository";
import { openCodeDb } from "@/storage/connection";
import { migrateCode } from "@/storage/migrations";

let dir: string;
let db: Database;
let code: CodeRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-symbol-hints-"));
	db = openCodeDb(dir);
	migrateCode(db);
	code = new CodeRepository(db);
	code.wipeAndRebuild([
		{
			file: {
				path: "src/auth/service.ts",
				lang: "ts",
				hash: "a",
				mtime: 1,
				size: 1,
			},
			symbols: [
				{ name: "AuthService", kind: "class", line: 3 },
				{ name: "AuthService.validateToken", kind: "method", line: 10 },
			],
			imports: [],
		},
	]);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("symbolHint", () => {
	test("suggests close matches from the same file", () => {
		expect(symbolHint(code, "src/auth/service.ts", "validateToken")).toBe(
			" — did you mean: AuthService.validateToken?",
		);
	});

	test("returns an empty hint when nothing resembles the symbol", () => {
		expect(symbolHint(code, "src/auth/service.ts", "zzz")).toBe("");
	});
});
