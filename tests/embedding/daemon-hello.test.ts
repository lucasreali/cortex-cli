import { describe, expect, test } from "bun:test";
import {
	DAEMON_PROTOCOL,
	type DaemonHello,
	encodeDaemonHello,
	helloAccepted,
	parseDaemonHello,
} from "@/embedding/daemon/hello";

const HELLO: DaemonHello = {
	cortex: "0.1.0",
	protocol: DAEMON_PROTOCOL,
	pid: 4242,
	modelId: "model@1",
};

describe("daemon hello", () => {
	test("encode/parse round-trips", () => {
		expect(parseDaemonHello(encodeDaemonHello(HELLO).trim())).toEqual(HELLO);
	});

	test("rejects garbage, non-objects and missing fields", () => {
		expect(parseDaemonHello("{oops")).toBeNull();
		expect(parseDaemonHello("42")).toBeNull();
		expect(parseDaemonHello("null")).toBeNull();
		expect(parseDaemonHello(JSON.stringify({ cortex: "0.1.0" }))).toBeNull();
		expect(
			parseDaemonHello(JSON.stringify({ ...HELLO, pid: "not-a-pid" })),
		).toBeNull();
	});

	test("rejects a future protocol number", () => {
		expect(
			parseDaemonHello(JSON.stringify({ ...HELLO, protocol: 2 })),
		).toBeNull();
	});

	test("helloAccepted requires version and model to match", () => {
		expect(helloAccepted(HELLO, "0.1.0", "model@1")).toBe(true);
		expect(helloAccepted(HELLO, "0.2.0", "model@1")).toBe(false);
		expect(helloAccepted(HELLO, "0.1.0", "other@1")).toBe(false);
	});
});
