import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import type { GemmaProvider } from "@/embedding/gemma-provider";
import { IdleTimer } from "@/embedding/idle-timer";
import { embedDeadlineMs } from "@/embedding/model-cache";
import {
	encodeNdjson,
	LineBuffer,
	linesSalvagedFrom,
} from "@/embedding/ndjson";
import {
	DAEMON_BUSY,
	decodeRequest,
	type WorkerRequest,
	type WorkerResponse,
} from "@/embedding/protocol";
import { SerialLane } from "@/embedding/serial-lane";
import { SocketWriter } from "@/embedding/socket-writer";
import { disposingOnTimeout } from "@/embedding/with-timeout";
import { errorMessage } from "@/support/errors";
import { withTimeout } from "@/support/with-timeout";
import { DAEMON_PROTOCOL, encodeDaemonHello } from "./hello";

export interface EmbeddingDaemonOptions {
	socketPath: string;
	version: string;
	provider: GemmaProvider;
	idleTimeoutMs?: number;
	requestTimeoutMs?: number;
	laneDepth?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface ClientState {
	lines: LineBuffer;
	writer: SocketWriter;
}

type ClientSocket = Socket<ClientState>;

interface SocketListener {
	stop(closeActiveConnections?: boolean): void;
}

export class EmbeddingDaemon {
	private readonly clients = new Set<ClientSocket>();
	private readonly lane: SerialLane;
	private readonly closedState = Promise.withResolvers<string>();
	private readonly idleTimer: IdleTimer;
	private listener: SocketListener | null = null;
	private stopping = false;

	constructor(private readonly options: EmbeddingDaemonOptions) {
		this.idleTimer = new IdleTimer(options.idleTimeoutMs);
		this.lane = new SerialLane(options.laneDepth);
	}

	start(): void {
		restrictDirectoryToOwner(dirname(this.options.socketPath));
		removeSocketFileIfPresent(this.options.socketPath);
		const drop = (socket: ClientSocket) => this.dropClient(socket);
		this.listener = Bun.listen<ClientState>({
			unix: this.options.socketPath,
			socket: {
				open: (socket) => this.acceptClient(socket),
				data: (socket, chunk) => this.receive(socket, chunk),
				drain: (socket) => socket.data.writer.flush(socket),
				close: drop,
				error: drop,
			},
		});
		restrictSocketToOwner(this.options.socketPath);
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
		socket.data = { lines: new LineBuffer(), writer: new SocketWriter() };
		this.clients.add(socket);
		this.idleTimer.clear();
		socket.data.writer.write(
			socket,
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

	// One session must never fault the daemon serving every other session, so a
	// client that overruns the line buffer or dies mid-write is simply dropped.
	private receive(socket: ClientSocket, chunk: Uint8Array): void {
		for (const line of this.buffer(socket, chunk)) {
			void this.respond(socket, line);
		}
	}

	private buffer(socket: ClientSocket, chunk: Uint8Array): string[] {
		try {
			return socket.data.lines.push(chunk);
		} catch (error) {
			this.dropClient(socket);
			return linesSalvagedFrom(error);
		}
	}

	// Nobody awaits this promise, so it must not be able to reject: an unhandled
	// rejection here would fault a process shared by every session. Each step
	// answers instead of throwing — decodeRequest returns null on a line it
	// cannot read, serve turns every failure into an error response, and deliver
	// writes through a socket Bun reports refusals from rather than throwing.
	private async respond(socket: ClientSocket, line: string): Promise<void> {
		const request = decodeRequest(line);
		if (!request) return;
		if (this.lane.full) {
			this.deliver(socket, { id: request.id, error: DAEMON_BUSY });
			return;
		}
		this.deliver(socket, await this.serve(socket, request));
	}

	private async serve(
		socket: ClientSocket,
		request: WorkerRequest,
	): Promise<WorkerResponse> {
		try {
			const vectors = await this.lane.run(() => this.embedFor(socket, request));
			return { id: request.id, vectors: vectors.map((vector) => [...vector]) };
		} catch (error) {
			return { id: request.id, error: errorMessage(error) };
		}
	}

	// The lane starts a unit only once it reaches the head, which is where a
	// session that gave up is discovered before the worker spends an inference
	// on an answer no one will read.
	private embedFor(
		socket: ClientSocket,
		request: WorkerRequest,
	): Promise<Float32Array[]> {
		if (!this.clients.has(socket)) {
			return Promise.reject(new Error("client disconnected"));
		}
		return this.embedWithTimeout(request);
	}

	// The worker embeds one request at a time, so the daemon queues instead of
	// pipelining: the deadline starts when a request reaches the worker, never
	// while it waits behind another session, and the dispose can only lose the
	// single request the worker is holding.
	//
	// Which deadline, and whether it disposes, follow the same two rules the
	// in-process paths follow: a query never costs the worker its life (the
	// caller answers from FTS and the model keeps loading for the next query),
	// and a model still being fetched is not a hung worker.
	private embedWithTimeout(request: WorkerRequest): Promise<Float32Array[]> {
		const { provider } = this.options;
		const work = provider.embed(request.kind, request.texts);
		const timeoutMs = embedDeadlineMs(
			provider,
			this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		);
		if (request.kind === "query") return withTimeout(work, timeoutMs);
		return disposingOnTimeout(provider, work, timeoutMs);
	}

	private deliver(socket: ClientSocket, response: WorkerResponse): void {
		if (!this.clients.has(socket)) return;
		socket.data.writer.write(socket, encodeNdjson(response));
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

// The socket is world-permissioned for the window between `listen` and its
// chmod, so the containing directory is what actually keeps other users out —
// and a daemon directory that already existed never got the 0o700 its creation
// asked for.
function restrictDirectoryToOwner(directory: string): void {
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	} catch {}
}

function restrictSocketToOwner(socketPath: string): void {
	try {
		chmodSync(socketPath, 0o600);
	} catch {}
}
