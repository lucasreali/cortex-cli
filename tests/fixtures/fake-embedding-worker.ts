// Speaks the embedding worker's NDJSON protocol without loading a model.
// Magic first-texts drive failure modes: "!exit" kills the process before
// answering, "!error" answers an error, "!empty" answers zero vectors,
// "!noise" emits garbage lines before the real answer, "!hang" never answers
// at all and "!slow:<ms>" answers normally after that delay.
//
// Requests are awaited one at a time, like the real worker, so a slow request
// delays the ones queued behind it.

interface Request {
	id: number;
	kind: "query" | "passages";
	texts: string[];
}

function out(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handle(line: string): Promise<void> {
	const request = JSON.parse(line) as Request;
	const [first] = request.texts;
	if (first === "!exit") process.exit(1);
	if (first === "!hang") return;
	if (first?.startsWith("!slow:")) {
		await Bun.sleep(Number(first.slice("!slow:".length)));
	}
	if (first === "!error") {
		out({ id: request.id, error: "boom" });
		return;
	}
	if (first === "!empty") {
		out({ id: request.id, vectors: [] });
		return;
	}
	if (first === "!noise") {
		process.stdout.write("\n");
		out({ id: 999_999, vectors: [] });
	}
	out({
		id: request.id,
		vectors: request.texts.map((text, index) => [
			text.length,
			index,
			request.kind === "query" ? 1 : 0,
		]),
	});
}

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let newline = buffered.indexOf("\n");
	while (newline >= 0) {
		const line = buffered.slice(0, newline).trim();
		buffered = buffered.slice(newline + 1);
		if (line) await handle(line);
		newline = buffered.indexOf("\n");
	}
}
