import {
	type ConnectOptions,
	connectToDaemon,
	type DaemonConnection,
	type DaemonEndpoint,
} from "@/embedding/daemon/client";
import { type DaemonPaths, daemonPathsFor } from "@/embedding/daemon/paths";
import { CORTEX_VERSION } from "@/version";
import type { GemmaProvider } from "./gemma-provider";
import { KindEmbeddingProvider } from "./kind-provider";
import { type EmbedKind, isDaemonBusy } from "./protocol";

export interface SharedEmbeddingProviderOptions extends ConnectOptions {
	paths?: DaemonPaths;
	version?: string;
	now?: () => number;
}

// How long "the daemon cannot be reached" stays the answer. It used to stay it
// for the life of the process: one failed spawn at the start of a week-long MCP
// session pinned that session to its own private worker, ~1.3 GB each, long
// after a daemon was available again.
export const DAEMON_RETRY_AFTER_MS = 60_000;

// Multiplexes embedding onto the user-wide daemon so N concurrent sessions
// share one model load, degrading to the private worker whenever the daemon
// cannot be reached or answers `busy` — sharing is an optimization, never a
// dependency.
export class SharedEmbeddingProvider extends KindEmbeddingProvider {
	private connection: DaemonConnection | null = null;
	private connecting: Promise<DaemonConnection | null> | null = null;
	private unavailableUntil = 0;

	constructor(
		private readonly direct: GemmaProvider,
		private readonly options: SharedEmbeddingProviderOptions = {},
	) {
		super(direct.modelId, (kind, texts) => this.sendToDaemon(kind, texts));
	}

	get daemonConnected(): boolean {
		return this.connection?.alive ?? false;
	}

	modelResident(): boolean {
		return this.direct.modelResident();
	}

	dispose(): void {
		this.connection?.close();
		this.connection = null;
		this.direct.dispose();
	}

	// The ladder has three rungs, and a daemon that dies mid-request must not
	// skip the middle one. Which failure this is, the connection already knows:
	// a daemon that answered `error` is still open and returned a verdict the
	// private worker would only repeat, while a transport failure closes the
	// link before rejecting — that one is retried locally, once. `busy` is the
	// one answer a live daemon gives that is not a verdict: its lane is already
	// deeper than the deadline of everything waiting in it, so the private
	// worker is the faster answer as well as the next rung down.
	private async sendToDaemon(
		kind: EmbedKind,
		texts: string[],
	): Promise<Float32Array[]> {
		const connection = await this.ensureConnection();
		if (!connection) return this.direct.embed(kind, texts);
		try {
			const vectors = await connection.embed(kind, texts);
			return vectors.map((values) => Float32Array.from(values));
		} catch (error) {
			if (connection.alive && !isDaemonBusy(error)) throw error;
			return this.direct.embed(kind, texts);
		}
	}

	private async ensureConnection(): Promise<DaemonConnection | null> {
		if (this.connection?.alive) return this.connection;
		if (this.connection) this.forgetDroppedConnection();
		if (this.now() < this.unavailableUntil) return null;
		this.connecting ??= this.connect();
		try {
			return await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	// A drop invalidates the availability verdict: the daemon may have been
	// restarted (e.g. by an upgrade), so the next embed runs a fresh cycle.
	private forgetDroppedConnection(): void {
		this.connection = null;
		this.unavailableUntil = 0;
	}

	private async connect(): Promise<DaemonConnection | null> {
		const connection = await connectToDaemon(this.endpoint(), this.options);
		this.connection = connection;
		this.unavailableUntil =
			connection === null ? this.now() + DAEMON_RETRY_AFTER_MS : 0;
		return connection;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private endpoint(): DaemonEndpoint {
		return {
			paths: this.options.paths ?? daemonPathsFor(this.modelId),
			version: this.options.version ?? CORTEX_VERSION,
			modelId: this.modelId,
		};
	}
}
