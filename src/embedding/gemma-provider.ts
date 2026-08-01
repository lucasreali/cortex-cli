import type { Subprocess } from "bun";
import { LineBuffer } from "./line-buffer";
import { GEMMA_MODEL } from "./model";
import { modelsDir } from "./models-dir";
import type { EmbedKind } from "./protocol";
import type { EmbeddingProvider } from "./provider";
import { VectorRequestLedger } from "./request-ledger";
import { embedWorkerCommand } from "./subprocess-command";

export interface GemmaProviderOptions {
	idleTimeoutMs?: number;
	modelsDir?: string;
	workerPath?: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

type WorkerSubprocess = Subprocess<"pipe", "pipe", "inherit">;

class WorkerLink {
	private readonly ledger = new VectorRequestLedger();

	constructor(private readonly subprocess: WorkerSubprocess) {
		// A stdout that errors mid-read (a kill during a read, EPIPE) leaves
		// every open request unanswerable, exactly like the worker exiting.
		this.readResponses().catch(() =>
			this.ledger.rejectAll(new Error("embedding worker stream failed")),
		);
		void this.subprocess.exited.then(() =>
			this.ledger.rejectAll(new Error("embedding worker exited")),
		);
	}

	get alive(): boolean {
		return this.subprocess.exitCode === null && !this.subprocess.killed;
	}

	send(kind: EmbedKind, texts: string[]): Promise<number[][]> {
		const { request, vectors } = this.ledger.open(kind, texts);
		this.subprocess.stdin.write(`${JSON.stringify(request)}\n`);
		this.subprocess.stdin.flush();
		return vectors;
	}

	kill(): void {
		this.subprocess.kill();
	}

	private async readResponses(): Promise<void> {
		const lines = new LineBuffer();
		for await (const chunk of this.subprocess.stdout) {
			for (const line of lines.push(chunk)) {
				this.ledger.settle(line);
			}
		}
	}
}

export class GemmaProvider implements EmbeddingProvider {
	readonly modelId: string = GEMMA_MODEL.modelId;
	private link: WorkerLink | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private inFlight = 0;

	constructor(private readonly options: GemmaProviderOptions = {}) {}

	async embedQuery(text: string): Promise<Float32Array> {
		const [vector] = await this.embed("query", [text]);
		if (!vector) throw new Error("embedding worker returned no vector");
		return vector;
	}

	async embedPassages(texts: string[]): Promise<Float32Array[]> {
		return this.embed("passages", texts);
	}

	embed(kind: EmbedKind, texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return Promise.resolve([]);
		return this.request(kind, texts);
	}

	get workerRunning(): boolean {
		return this.link?.alive ?? false;
	}

	dispose(): void {
		this.clearIdleTimer();
		this.link?.kill();
		this.link = null;
	}

	private async request(
		kind: EmbedKind,
		texts: string[],
	): Promise<Float32Array[]> {
		const link = this.ensureLink();
		this.clearIdleTimer();
		this.inFlight++;
		try {
			const vectors = await link.send(kind, texts);
			return vectors.map((values) => Float32Array.from(values));
		} finally {
			this.inFlight--;
			this.scheduleIdleKill();
		}
	}

	private ensureLink(): WorkerLink {
		if (this.link?.alive) return this.link;
		this.link = new WorkerLink(this.spawnWorker());
		return this.link;
	}

	private spawnWorker(): WorkerSubprocess {
		const command = embedWorkerCommand(this.options.workerPath);
		return Bun.spawn([command.executable, ...command.argv], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: {
				...process.env,
				CORTEX_MODELS_DIR: this.options.modelsDir ?? modelsDir(),
			},
		});
	}

	private scheduleIdleKill(): void {
		if (this.inFlight > 0) return;
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			this.link?.kill();
			this.link = null;
		}, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}
}
