import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { GEMMA_MODEL } from "./model";
import type { EmbedKind, WorkerRequest, WorkerResponse } from "./protocol";
import type { EmbeddingProvider } from "./provider";

export interface GemmaProviderOptions {
	idleTimeoutMs?: number;
	modelsDir?: string;
	workerPath?: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

type WorkerSubprocess = Subprocess<"pipe", "pipe", "inherit">;

interface PendingRequest {
	resolve(vectors: number[][]): void;
	reject(error: Error): void;
}

class WorkerLink {
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;

	constructor(private readonly subprocess: WorkerSubprocess) {
		void this.readResponses();
		void this.subprocess.exited.then(() =>
			this.rejectAll(new Error("embedding worker exited")),
		);
	}

	get alive(): boolean {
		return this.subprocess.exitCode === null && !this.subprocess.killed;
	}

	send(kind: EmbedKind, texts: string[]): Promise<number[][]> {
		const request: WorkerRequest = { id: this.nextRequestId++, kind, texts };
		this.subprocess.stdin.write(`${JSON.stringify(request)}\n`);
		this.subprocess.stdin.flush();
		return new Promise((resolve, reject) => {
			this.pending.set(request.id, { resolve, reject });
		});
	}

	kill(): void {
		this.subprocess.kill();
	}

	private async readResponses(): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of this.subprocess.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				this.dispatch(buffered.slice(0, newline).trim());
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
		}
	}

	private dispatch(line: string): void {
		if (!line) return;
		const response = JSON.parse(line) as WorkerResponse;
		const entry = this.pending.get(response.id);
		if (!entry) return;
		this.pending.delete(response.id);
		if ("error" in response) {
			entry.reject(new Error(response.error));
			return;
		}
		entry.resolve(response.vectors);
	}

	private rejectAll(error: Error): void {
		for (const entry of this.pending.values()) {
			entry.reject(error);
		}
		this.pending.clear();
	}
}

export class GemmaProvider implements EmbeddingProvider {
	readonly modelId: string = GEMMA_MODEL.modelId;
	private link: WorkerLink | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private inFlight = 0;

	constructor(private readonly options: GemmaProviderOptions = {}) {}

	async embedQuery(text: string): Promise<Float32Array> {
		const [vector] = await this.request("query", [text]);
		if (!vector) throw new Error("embedding worker returned no vector");
		return vector;
	}

	async embedPassages(texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		return this.request("passages", texts);
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
		const workerPath =
			this.options.workerPath ??
			new URL("./worker.ts", import.meta.url).pathname;
		return Bun.spawn(["bun", workerPath], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: { ...process.env, CORTEX_MODELS_DIR: this.modelsDir() },
		});
	}

	private modelsDir(): string {
		return this.options.modelsDir ?? join(homedir(), ".cortex", "models");
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
