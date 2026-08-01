import type { Subprocess } from "bun";
import { IdleTimer } from "./idle-timer";
import { KindEmbeddingProvider } from "./kind-provider";
import { GEMMA_MODEL } from "./model";
import { modelsDir } from "./models-dir";
import { encodeNdjson, LineBuffer } from "./ndjson";
import type { EmbedKind } from "./protocol";
import { VectorRequestLedger } from "./request-ledger";
import { embedWorkerCommand } from "./subprocess-command";

export interface GemmaProviderOptions {
	idleTimeoutMs?: number;
	modelsDir?: string;
	workerPath?: string;
}

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
		this.subprocess.stdin.write(encodeNdjson(request));
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

export class GemmaProvider extends KindEmbeddingProvider {
	private readonly idleTimer: IdleTimer;
	private link: WorkerLink | null = null;
	private inFlight = 0;

	constructor(private readonly options: GemmaProviderOptions = {}) {
		super(GEMMA_MODEL.modelId, (kind, texts) => this.sendToWorker(kind, texts));
		this.idleTimer = new IdleTimer(options.idleTimeoutMs);
	}

	get workerRunning(): boolean {
		return this.link?.alive ?? false;
	}

	dispose(): void {
		this.idleTimer.clear();
		this.link?.kill();
		this.link = null;
	}

	private async sendToWorker(
		kind: EmbedKind,
		texts: string[],
	): Promise<Float32Array[]> {
		const link = this.ensureLink();
		this.idleTimer.clear();
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
		this.idleTimer.arm(() => {
			this.link?.kill();
			this.link = null;
		});
	}
}
