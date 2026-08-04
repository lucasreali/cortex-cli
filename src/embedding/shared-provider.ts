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
import type { EmbedKind } from "./protocol";

export interface SharedEmbeddingProviderOptions extends ConnectOptions {
	paths?: DaemonPaths;
	version?: string;
}

// Multiplexes embedding onto the user-wide daemon so N concurrent sessions
// share one model load, degrading to the private worker whenever the daemon
// cannot be reached — sharing is an optimization, never a dependency.
export class SharedEmbeddingProvider extends KindEmbeddingProvider {
	private connection: DaemonConnection | null = null;
	private connecting: Promise<DaemonConnection | null> | null = null;
	private daemonUnavailable = false;

	constructor(
		private readonly direct: GemmaProvider,
		private readonly options: SharedEmbeddingProviderOptions = {},
	) {
		super(direct.modelId, (kind, texts) => this.sendToDaemon(kind, texts));
	}

	get daemonConnected(): boolean {
		return this.connection?.alive ?? false;
	}

	dispose(): void {
		this.connection?.close();
		this.connection = null;
		this.direct.dispose();
	}

	private async sendToDaemon(
		kind: EmbedKind,
		texts: string[],
	): Promise<Float32Array[]> {
		const connection = await this.ensureConnection();
		if (!connection) return this.direct.embed(kind, texts);
		const vectors = await connection.embed(kind, texts);
		return vectors.map((values) => Float32Array.from(values));
	}

	private async ensureConnection(): Promise<DaemonConnection | null> {
		if (this.connection?.alive) return this.connection;
		if (this.connection) this.forgetDroppedConnection();
		if (this.daemonUnavailable) return null;
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
		this.daemonUnavailable = false;
	}

	private async connect(): Promise<DaemonConnection | null> {
		const connection = await connectToDaemon(this.endpoint(), this.options);
		this.connection = connection;
		this.daemonUnavailable = connection === null;
		return connection;
	}

	private endpoint(): DaemonEndpoint {
		return {
			paths: this.options.paths ?? daemonPathsFor(this.modelId),
			version: this.options.version ?? CORTEX_VERSION,
			modelId: this.modelId,
		};
	}
}
