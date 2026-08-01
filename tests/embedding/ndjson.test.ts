import { describe, expect, test } from "bun:test";
import { encodeNdjson, LineBuffer } from "@/embedding/ndjson";

describe("LineBuffer", () => {
	test("splits complete lines and holds the partial tail", () => {
		const lines = new LineBuffer();
		expect(lines.push('{"id":1}\n{"id":2}\n{"id')).toEqual([
			'{"id":1}',
			'{"id":2}',
		]);
		expect(lines.push('":3}\n')).toEqual(['{"id":3}']);
	});

	test("drops blank and whitespace-only lines", () => {
		const lines = new LineBuffer();
		expect(lines.push("\n  \nvalue\n\n")).toEqual(["value"]);
	});

	test("reassembles a UTF-8 character split across chunks", () => {
		const encoded = new TextEncoder().encode("café\n");
		const lines = new LineBuffer();
		expect(lines.push(encoded.slice(0, 4))).toEqual([]);
		expect(lines.push(encoded.slice(4))).toEqual(["café"]);
	});

	test("accepts string chunks alongside binary ones", () => {
		const lines = new LineBuffer();
		expect(lines.push("first\nsec")).toEqual(["first"]);
		expect(lines.push(new TextEncoder().encode("ond\n"))).toEqual(["second"]);
	});

	test("rejects a peer that never terminates its line", () => {
		const lines = new LineBuffer();
		expect(() => lines.push("x".repeat(8 * 1024 * 1024 + 1))).toThrow(
			"maximum length",
		);
	});

	test("stays usable after rejecting an overlong line", () => {
		const lines = new LineBuffer();
		expect(() => lines.push("x".repeat(8 * 1024 * 1024 + 1))).toThrow();
		expect(lines.push("recovered\n")).toEqual(["recovered"]);
	});
});

describe("encodeNdjson", () => {
	test("frames a message as one newline-terminated JSON line", () => {
		expect(encodeNdjson({ id: 1, kind: "query" })).toBe(
			'{"id":1,"kind":"query"}\n',
		);
	});

	test("what it writes is what LineBuffer reads back", () => {
		const message = { id: 7, texts: ["a\nb", "café"] };
		expect(new LineBuffer().push(encodeNdjson(message))).toEqual([
			JSON.stringify(message),
		]);
	});
});
