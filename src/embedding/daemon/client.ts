import { closeSync, mkdirSync, openSync } from "node:fs";
import type { Socket } from "bun";
import { LineBuffer } from "@/embedding/line-buffer";
import type { EmbedKind } from "@/embedding/protocol";
import { VectorRequestLedger } from "@/embedding/request-ledger";
import { embedDaemonCommand } from "@/embedding/subprocess-command";
import { withTimeout } from "@/embedding/with-timeout";
import { type DaemonHello, helloAccepted, parseDaemonHello } from "./hello";
import type { DaemonPaths } from "./paths";

export interface DaemonEndpoint {
	paths: DaemonPaths;
	version: string;
	modelId: string;
}

export interface ConnectOptions {
	spawnDaemon?: boolean;
	daemonWorkerPath?: string;
	daemonIdleTimeoutMs?: number;
	helloTimeoutMs?: number;
	pollAttempts?: number;
	pollDelayMs?: number;
}

const HELLO_TIMEOUT_MS = 2000;
const SPAWN_POLL_ATTEMPTS = 80;
const SPAWN_POLL_DELAY_MS = 50;

// "unreachable" means nothing is listening (a spawn can fix it); "rejected"
// means something answered but cannot serve us (wrong version or model, or a
// non-daemon owner) — spawning would lose the lock race to the live holder.
export type DaemonProbe =
	| { status: "connected"; connection: DaemonConnection }
	| { status: "rejected" }
	| { status: "unreachable" };

interface LinkState {
	lines: LineBuffer;
	ledger: VectorRequestLedger;
	hello: PromiseWithResolvers<DaemonHello | null>;
	helloSeen: boolean;
	open: boolean;
}

export class DaemonConnection {
	constructor(
		private readonly socket: Socket<undefined>,
		private readonly state: LinkState,
		readonly hello: DaemonHello,
	) {}

	get alive(): boolean {
		return this.state.open;
	}

	embed(kind: EmbedKind, texts: string[]): Promise<number[][]> {
		const { request, vectors } = this.state.ledger.open(kind, texts);
		this.socket.write(`${JSON.stringify(request)}\n`);
		return vectors;
	}

	close(): void {
		this.state.open = false;
		this.socket.end();
		this.state.ledger.rejectAll(
			new Error("embedding daemon connection closed"),
		);
	}
}

export async function connectToDaemon(
	endpoint: DaemonEndpoint,
	options: ConnectOptions = {},
): Promise<DaemonConnection | null> {
	const first = await probeDaemon(endpoint, options);
	if (first.status === "connected") return first.connection;
	if (first.status === "rejected") return null;
	if (options.spawnDaemon === false) return null;
	spawnDetachedDaemon(endpoint, options);
	return pollForDaemon(endpoint, options);
}

export async function probeDaemon(
	endpoint: DaemonEndpoint,
	options: ConnectOptions = {},
): Promise<DaemonProbe> {
	const state = newLinkState();
	const teardown = () => disconnect(state);
	let socket: Socket<undefined>;
	try {
		socket = await Bun.connect({
			unix: endpoint.paths.socketPath,
			socket: {
				data: (_socket, chunk) => deliver(state, chunk),
				close: teardown,
				error: teardown,
			},
		});
	} catch {
		return { status: "unreachable" };
	}
	state.open = true;
	const hello = await withTimeout(
		state.hello.promise,
		options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
	).catch(() => null);
	if (!hello || !helloAccepted(hello, endpoint.version, endpoint.modelId)) {
		socket.end();
		return { status: "rejected" };
	}
	return {
		status: "connected",
		connection: new DaemonConnection(socket, state, hello),
	};
}

export function spawnDetachedDaemon(
	endpoint: DaemonEndpoint,
	options: ConnectOptions = {},
): void {
	const command = embedDaemonCommand(endpoint.modelId);
	mkdirSync(endpoint.paths.directory, { recursive: true, mode: 0o700 });
	const log = openLogFile(endpoint.paths.logPath);
	try {
		const child = Bun.spawn([command.executable, ...command.argv], {
			detached: true,
			stdin: "ignore",
			stdout: log ?? "ignore",
			stderr: log ?? "ignore",
			env: daemonEnvironment(endpoint, options),
		});
		child.unref();
	} finally {
		if (log !== null) closeSync(log);
	}
}

async function pollForDaemon(
	endpoint: DaemonEndpoint,
	options: ConnectOptions,
): Promise<DaemonConnection | null> {
	const attempts = options.pollAttempts ?? SPAWN_POLL_ATTEMPTS;
	const delayMs = options.pollDelayMs ?? SPAWN_POLL_DELAY_MS;
	for (let attempt = 0; attempt < attempts; attempt++) {
		await Bun.sleep(delayMs);
		const probe = await probeDaemon(endpoint, options);
		if (probe.status === "connected") return probe.connection;
		if (probe.status === "rejected") return null;
	}
	return null;
}

function newLinkState(): LinkState {
	return {
		lines: new LineBuffer(),
		ledger: new VectorRequestLedger(),
		hello: Promise.withResolvers<DaemonHello | null>(),
		helloSeen: false,
		open: false,
	};
}

function deliver(state: LinkState, chunk: Uint8Array): void {
	for (const line of state.lines.push(chunk)) {
		if (state.helloSeen) {
			state.ledger.settle(line);
			continue;
		}
		state.helloSeen = true;
		state.hello.resolve(parseDaemonHello(line));
	}
}

function disconnect(state: LinkState): void {
	state.open = false;
	state.hello.resolve(null);
	state.ledger.rejectAll(new Error("embedding daemon disconnected"));
}

function daemonEnvironment(
	endpoint: DaemonEndpoint,
	options: ConnectOptions,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		CORTEX_DAEMON_DIR: endpoint.paths.directory,
	};
	if (options.daemonWorkerPath) {
		environment.CORTEX_EMBED_WORKER_PATH = options.daemonWorkerPath;
	}
	if (options.daemonIdleTimeoutMs !== undefined) {
		environment.CORTEX_DAEMON_IDLE_TIMEOUT_MS = String(
			options.daemonIdleTimeoutMs,
		);
	}
	return environment;
}

function openLogFile(logPath: string): number | null {
	try {
		return openSync(logPath, "a", 0o600);
	} catch {
		return null;
	}
}
