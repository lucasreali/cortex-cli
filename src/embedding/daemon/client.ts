import {
	closeSync,
	mkdirSync,
	openSync,
	statSync,
	truncateSync,
} from "node:fs";
import type { Socket } from "bun";
import {
	encodeNdjson,
	LineBuffer,
	linesSalvagedFrom,
} from "@/embedding/ndjson";
import type { EmbedKind } from "@/embedding/protocol";
import { VectorRequestLedger } from "@/embedding/request-ledger";
import { SocketWriter } from "@/embedding/socket-writer";
import { embedDaemonCommand } from "@/embedding/subprocess-command";
import { withTimeout } from "@/support/with-timeout";
import { type DaemonHello, helloAccepted, parseDaemonHello } from "./hello";
import type { DaemonLock } from "./lock";
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

// The daemon appends its whole life to one file, the worker's model-download
// progress included, and nothing ever rotates it. Truncating at spawn keeps the
// run about to start — the one being debugged — diagnosable without a rotation
// scheme.
const MAX_DAEMON_LOG_BYTES = 1024 * 1024;

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
	writer: SocketWriter;
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

	// The ledger owns the write, so a daemon that dies between a caller's
	// liveness check and this line cannot leave a request nothing will answer.
	embed(kind: EmbedKind, texts: string[]): Promise<number[][]> {
		return this.state.ledger.dispatch(kind, texts, (request) =>
			this.state.writer.write(this.socket, encodeNdjson(request)),
		);
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
	if (!spawnDetachedDaemon(endpoint, options)) return null;
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
				drain: (drained) => state.writer.flush(drained),
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

// Whether a lock's holder is real is a connectivity question, not a
// compatibility one: a daemon of any version answering here means the pid in
// the lock file still belongs to it. A rejected handshake has already closed
// the socket; an accepted one is closed here.
export async function daemonSocketIsListening(
	endpoint: DaemonEndpoint,
	options: ConnectOptions = {},
): Promise<boolean> {
	const probe = await probeDaemon(endpoint, options);
	if (probe.status === "connected") probe.connection.close();
	return probe.status !== "unreachable";
}

// The pid a live daemon reports for itself on its own socket, whatever its
// version: the one answer about a lock's holder that a reused pid cannot fake.
export async function greetingPid(
	paths: DaemonPaths,
	holder: DaemonLock,
): Promise<number | null> {
	const probe = await probeDaemon(
		{ paths, version: holder.version, modelId: holder.modelId },
		{ helloTimeoutMs: LISTENER_PROBE_TIMEOUT_MS },
	);
	if (probe.status !== "connected") return null;
	probe.connection.close();
	return probe.connection.hello.pid;
}

// A daemon greets the moment it accepts, so a listener still silent after this
// is not one — and the wait is paid only by a process that already found a
// lock it cannot verify.
const LISTENER_PROBE_TIMEOUT_MS = 500;

export function listenerProbe(
	paths: DaemonPaths,
	holder: DaemonLock,
): () => Promise<boolean> {
	return () =>
		daemonSocketIsListening(
			{ paths, version: holder.version, modelId: holder.modelId },
			{ helloTimeoutMs: LISTENER_PROBE_TIMEOUT_MS },
		);
}

// A spawn that cannot even start (read-only home, EMFILE, full disk) means
// nothing will ever listen — report it as unreachable so callers degrade to
// the private worker instead of surfacing an error they cannot recover from.
function spawnDetachedDaemon(
	endpoint: DaemonEndpoint,
	options: ConnectOptions = {},
): boolean {
	try {
		launchDaemonProcess(endpoint, options);
		return true;
	} catch {
		return false;
	}
}

function launchDaemonProcess(
	endpoint: DaemonEndpoint,
	options: ConnectOptions,
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
		writer: new SocketWriter(),
		hello: Promise.withResolvers<DaemonHello | null>(),
		helloSeen: false,
		open: false,
	};
}

// A daemon that overruns the line cap is answering nothing further, but the
// responses that shared its final chunk are settled before the link is torn
// down — each one is a request whose caller is still waiting.
function deliver(state: LinkState, chunk: Uint8Array): void {
	try {
		accept(state, state.lines.push(chunk));
	} catch (error) {
		accept(state, linesSalvagedFrom(error));
		disconnect(state);
	}
}

function accept(state: LinkState, lines: string[]): void {
	for (const line of lines) {
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
		truncateOversizedLog(logPath);
		return openSync(logPath, "a", 0o600);
	} catch {
		return null;
	}
}

function truncateOversizedLog(logPath: string): void {
	try {
		if (statSync(logPath).size <= MAX_DAEMON_LOG_BYTES) return;
		truncateSync(logPath, 0);
	} catch {}
}
