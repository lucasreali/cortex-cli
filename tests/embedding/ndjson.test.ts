import { describe, expect, test } from "bun:test";
import {
	encodeNdjson,
	LineBuffer,
	linesSalvagedFrom,
	OverlongLineError,
} from "@/embedding/ndjson";

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

	// L8: the lines that arrived whole in the same chunk are still answerable,
	// and each one is a request whose caller is waiting.
	test("the overlong-line failure carries the lines completed before it", () => {
		const lines = new LineBuffer();
		const chunk = `first\nsecond\n${"x".repeat(8 * 1024 * 1024 + 1)}`;
		try {
			lines.push(chunk);
			throw new Error("expected an overlong line");
		} catch (error) {
			expect(error).toBeInstanceOf(OverlongLineError);
			expect(linesSalvagedFrom(error)).toEqual(["first", "second"]);
		}
	});

	test("an unrelated failure salvages nothing", () => {
		expect(linesSalvagedFrom(new Error("something else"))).toEqual([]);
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
