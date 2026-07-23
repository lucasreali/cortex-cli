export const DAEMON_PROTOCOL = 1;

export interface DaemonHello {
	cortex: string;
	protocol: typeof DAEMON_PROTOCOL;
	pid: number;
	modelId: string;
}

export function encodeDaemonHello(hello: DaemonHello): string {
	return `${JSON.stringify(hello)}\n`;
}

export function parseDaemonHello(line: string): DaemonHello | null {
	const parsed = decode(line);
	if (typeof parsed?.cortex !== "string") return null;
	if (parsed.protocol !== DAEMON_PROTOCOL) return null;
	if (typeof parsed.pid !== "number") return null;
	if (typeof parsed.modelId !== "string") return null;
	return parsed as DaemonHello;
}

export function helloAccepted(
	hello: DaemonHello,
	version: string,
	modelId: string,
): boolean {
	return hello.cortex === version && hello.modelId === modelId;
}

function decode(line: string): Partial<DaemonHello> | null {
	try {
		return JSON.parse(line) as Partial<DaemonHello>;
	} catch {
		return null;
	}
}
