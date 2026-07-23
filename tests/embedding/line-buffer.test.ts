import { describe, expect, test } from "bun:test";
import { LineBuffer } from "@/embedding/line-buffer";

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
});
