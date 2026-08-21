import { describe, expect, test } from "bun:test";
import { createDecisionSchema } from "@/domain";

const validInput = {
	title: "Adopt JWT for API authentication",
	body: "We use short-lived JWTs signed with RS256 because sessions must survive server restarts.",
	keywords: ["autenticação", "authentication", "jwt", "login", "token"],
};

function parse(overrides: Record<string, unknown>) {
	return createDecisionSchema.safeParse({ ...validInput, ...overrides });
}

describe("createDecisionSchema", () => {
	test("accepts a minimal valid input", () => {
		expect(createDecisionSchema.safeParse(validInput).success).toBe(true);
	});

	test("accepts a complete valid input", () => {
		const result = parse({
			module: "auth",
			anchors: [
				{ file_path: "src/auth/service.ts", symbol: "AuthService.login" },
				{ file_path: "src/auth/jwt.ts" },
			],
			depends_on: [Bun.randomUUIDv7(), Bun.randomUUIDv7()],
			replaces: Bun.randomUUIDv7(),
		});
		expect(result.success).toBe(true);
	});

	describe("title", () => {
		test("rejects when missing", () => {
			expect(parse({ title: undefined }).success).toBe(false);
		});

		test("rejects fewer than 8 characters", () => {
			expect(parse({ title: "7 chars" }).success).toBe(false);
		});

		test("accepts exactly 8 characters", () => {
			expect(parse({ title: "8 charss" }).success).toBe(true);
		});
	});

	describe("body", () => {
		test("rejects when missing", () => {
			expect(parse({ body: undefined }).success).toBe(false);
		});

		test("rejects fewer than 30 characters", () => {
			expect(parse({ body: "a".repeat(29) }).success).toBe(false);
		});

		test("accepts exactly 30 characters", () => {
			expect(parse({ body: "a".repeat(30) }).success).toBe(true);
		});

		// The file format trims the body back out, and its parser rejects an
		// empty one — so a body that only counts because of its whitespace would
		// save, return an id, and be malformed on disk from that moment on.
		test("rejects a body that is only whitespace", () => {
			expect(parse({ body: " ".repeat(40) }).success).toBe(false);
		});

		test("counts the trimmed body, and stores it trimmed", () => {
			const result = parse({ body: `  ${"a".repeat(29)}  ` });

			expect(result.success).toBe(false);
			expect(parse({ body: `  ${"a".repeat(30)}  ` })).toMatchObject({
				success: true,
				data: { body: "a".repeat(30) },
			});
		});
	});

	describe("keywords", () => {
		test("rejects when missing", () => {
			expect(parse({ keywords: undefined }).success).toBe(false);
		});

		test("rejects fewer than 5 items", () => {
			expect(parse({ keywords: ["a", "b", "c", "d"] }).success).toBe(false);
		});

		test("rejects empty-string items", () => {
			expect(parse({ keywords: ["a", "b", "c", "d", ""] }).success).toBe(false);
		});

		test("description instructs mixing PT and EN search terms", () => {
			const description = createDecisionSchema.shape.keywords.description;
			expect(description).toContain("Portuguese");
			expect(description).toContain("English");
		});
	});

	describe("module", () => {
		test("is optional", () => {
			expect(parse({ module: undefined }).success).toBe(true);
		});

		test("rejects empty string", () => {
			expect(parse({ module: "" }).success).toBe(false);
		});
	});

	describe("anchors", () => {
		test("are optional", () => {
			expect(parse({ anchors: undefined }).success).toBe(true);
		});

		test("accepts file_path without symbol", () => {
			expect(parse({ anchors: [{ file_path: "src/a.ts" }] }).success).toBe(
				true,
			);
		});

		test("rejects anchor without file_path", () => {
			expect(parse({ anchors: [{ symbol: "AuthService" }] }).success).toBe(
				false,
			);
		});

		test("rejects empty file_path", () => {
			expect(parse({ anchors: [{ file_path: "" }] }).success).toBe(false);
		});

		test("rejects unknown anchor keys", () => {
			const anchors = [{ file_path: "src/a.ts", line: 10 }];
			expect(parse({ anchors }).success).toBe(false);
		});

		// The anchor is written into a file that is immutable once committed, so
		// a path pointing outside the repository stays there for good.
		test("rejects a path that escapes the repository", () => {
			for (const file_path of [
				"/etc/passwd",
				"~/.ssh/id_rsa",
				"../../../etc/passwd",
				"src/../../outside.ts",
				"C:\\Windows\\System32\\drivers\\etc\\hosts",
				"src\\..\\..\\outside.ts",
			]) {
				expect(parse({ anchors: [{ file_path }] }).success).toBe(false);
			}
		});

		test("accepts a dot in a name that is not a segment of its own", () => {
			const anchors = [{ file_path: "src/..hidden/a.test.ts" }];
			expect(parse({ anchors }).success).toBe(true);
		});
	});

	describe("depends_on", () => {
		test("is optional", () => {
			expect(parse({ depends_on: undefined }).success).toBe(true);
		});

		test("accepts an array of UUIDs", () => {
			expect(parse({ depends_on: [Bun.randomUUIDv7()] }).success).toBe(true);
		});

		test("rejects non-UUID ids", () => {
			expect(parse({ depends_on: ["not-an-id"] }).success).toBe(false);
		});
	});

	describe("replaces", () => {
		test("is optional", () => {
			expect(parse({ replaces: undefined }).success).toBe(true);
		});

		test("accepts a UUID", () => {
			expect(parse({ replaces: Bun.randomUUIDv7() }).success).toBe(true);
		});

		test("rejects a non-UUID id", () => {
			expect(parse({ replaces: "decision-1" }).success).toBe(false);
		});
	});

	test("rejects unknown top-level keys", () => {
		expect(parse({ keyword: ["typo"] }).success).toBe(false);
	});
});
