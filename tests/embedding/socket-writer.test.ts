import { describe, expect, test } from "bun:test";
import { SocketWriter } from "@/embedding/socket-writer";

// Takes at most `accepts` bytes per call, like a socket whose kernel buffer is
// nearly full, and records every byte it did take.
class ShortWritingSocket {
	private readonly taken: number[] = [];

	constructor(private accepts: number) {}

	write(data: Uint8Array): number {
		const written = Math.min(this.accepts, data.length);
		this.taken.push(...data.subarray(0, written));
		return written;
	}

	stopRefusing(): void {
		this.accepts = Number.MAX_SAFE_INTEGER;
	}

	get received(): string {
		return new TextDecoder().decode(new Uint8Array(this.taken));
	}
}

describe("SocketWriter", () => {
	test("holds the bytes the socket refused and resends them on drain", () => {
		const socket = new ShortWritingSocket(3);
		const writer = new SocketWriter();

		writer.write(socket, "hello\n");
		expect(socket.received).toBe("hel");
		writer.flush(socket);
		expect(socket.received).toBe("hello\n");
	});

	// A tail sliced by characters instead of bytes cuts a multi-byte one in
	// half, and the peer reads a line it cannot decode.
	test("a multi-byte character split across writes arrives intact", () => {
		const socket = new ShortWritingSocket(1);
		const writer = new SocketWriter();

		writer.write(socket, "café\n");
		for (let attempt = 0; attempt < 6; attempt++) {
			writer.flush(socket);
		}
		expect(socket.received).toBe("café\n");
	});

	test("messages queued behind a refused tail keep their order", () => {
		const socket = new ShortWritingSocket(2);
		const writer = new SocketWriter();

		writer.write(socket, "first\n");
		writer.write(socket, "second\n");
		socket.stopRefusing();
		writer.flush(socket);
		expect(socket.received).toBe("first\nsecond\n");
	});

	test("a flush with nothing pending does not touch the socket", () => {
		const socket = new ShortWritingSocket(0);
		const writer = new SocketWriter();
		writer.flush(socket);
		expect(socket.received).toBe("");
	});

	// A socket that throws has already gone; the requests it owed are settled by
	// the close handler, so the writer drops the tail instead of faulting.
	test("a socket that throws mid-write does not propagate", () => {
		const writer = new SocketWriter();
		const broken = {
			write(): number {
				throw new Error("EPIPE");
			},
		};
		expect(() => writer.write(broken, "gone\n")).not.toThrow();
	});
});
