import { chmodSync, unlinkSync } from "node:fs";
import type { Socket } from "bun";
import type { GemmaProvider } from "@/embedding/gemma-provider";
import { IdleTimer } from "@/embedding/idle-timer";
import { encodeNdjson, LineBuffer } from "@/embedding/ndjson";
import {
	decodeRequest,
	type WorkerRequest,
	type WorkerResponse,
} from "@/embedding/protocol";
import { SerialLane } from "@/embedding/serial-lane";
import { disposingOnTimeout } from "@/embedding/with-timeout";
import { errorMessage } from "@/support/errors";
import { DAEMON_PROTOCOL, encodeDaemonHello } from "./hello";

export interface EmbeddingDaemonOptions {
	socketPath: string;
	version: string;
	provider: GemmaProvider;
	idleTimeoutMs?: number;
	requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface ClientState {
	lines: LineBuffer;
}

type ClientSocket = Socket<ClientState>;

interface SocketListener {
	stop(closeActiveConnections?: boolean): void;
}

export class EmbeddingDaemon {
	private readonly clients = new Set<ClientSocket>();
	private readonly lane = new SerialLane();
	private readonly closedState = Promise.withResolvers<string>();
	private readonly idleTimer: IdleTimer;
	private listener: SocketListener | null = null;
	private stopping = false;

	constructor(private readonly options: EmbeddingDaemonOptions) {
		this.idleTimer = new IdleTimer(options.idleTimeoutMs);
	}

	start(): void {
		removeSocketFileIfPresent(this.options.socketPath);
		const drop = (socket: ClientSocket) => this.dropClient(socket);
		this.listener = Bun.listen<ClientState>({
			unix: this.options.socketPath,
			socket: {
				open: (socket) => this.acceptClient(socket),
				data: (socket, chunk) => this.receive(socket, chunk),
				close: drop,
				error: drop,
			},
		});
		restrictToOwner(this.options.socketPath);
		this.armIdleTimer();
	}

	get clientCount(): number {
		return this.clients.size;
	}

	get closed(): Promise<string> {
		return this.closedState.promise;
	}

	stop(reason: string): void {
		if (this.stopping) return;
		this.stopping = true;
		this.idleTimer.clear();
		for (const client of this.clients) {
			client.end();
		}
		this.clients.clear();
		this.listener?.stop(true);
		this.options.provider.dispose();
		removeSocketFileIfPresent(this.options.socketPath);
		this.closedState.resolve(reason);
	}

	private acceptClient(socket: ClientSocket): void {
		socket.data = { lines: new LineBuffer() };
		this.clients.add(socket);
		this.idleTimer.clear();
		socket.write(
			encodeDaemonHello({
				cortex: this.options.version,
				protocol: DAEMON_PROTOCOL,
				pid: process.pid,
				modelId: this.options.provider.modelId,
			}),
		);
	}

	private dropClient(socket: ClientSocket): void {
		socket.end();
		if (!this.clients.delete(socket)) return;
		if (this.clients.size === 0) this.armIdleTimer();
	}

	private receive(socket: ClientSocket, chunk: Uint8Array): void {
		for (const line of this.buffer(socket, chunk)) {
			void this.respond(socket, line);
		}
	}

	// One session must never fault the daemon serving every other session, so a
	// client that overruns the line buffer or dies mid-write is simply dropped.
	private buffer(socket: ClientSocket, chunk: Uint8Array): string[] {
		try {
			return socket.data.lines.push(chunk);
		} catch {
			this.dropClient(socket);
			return [];
		}
	}

	private async respond(socket: ClientSocket, line: string): Promise<void> {
		const request = decodeRequest(line);
		if (!request) return;
		this.deliver(socket, await this.serve(request));
	}

	private async serve(request: WorkerRequest): Promise<WorkerResponse> {
		try {
			const vectors = await this.lane.run(() => this.embedWithTimeout(request));
			return { id: request.id, vectors: vectors.map((vector) => [...vector]) };
		} catch (error) {
			return { id: request.id, error: errorMessage(error) };
		}
	}

	// The worker embeds one request at a time, so the daemon queues instead of
	// pipelining: the deadline starts when a request reaches the worker, never
	// while it waits behind another session, and the dispose can only lose the
	// single request the worker is holding.
	private embedWithTimeout(request: WorkerRequest): Promise<Float32Array[]> {
		return disposingOnTimeout(
			this.options.provider,
			this.options.provider.embed(request.kind, request.texts),
			this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		);
	}

	private deliver(socket: ClientSocket, response: WorkerResponse): void {
		if (!this.clients.has(socket)) return;
		socket.write(encodeNdjson(response));
	}

	private armIdleTimer(): void {
		if (this.stopping) return;
		this.idleTimer.arm(() => {
			if (this.clients.size === 0) this.stop("idle timeout");
		});
	}
}

function removeSocketFileIfPresent(socketPath: string): void {
	try {
		unlinkSync(socketPath);
	} catch {}
}

function restrictToOwner(socketPath: string): void {
	try {
		chmodSync(socketPath, 0o600);
	} catch {
		// Best-effort: the daemon directory is already user-only.
	}
}
