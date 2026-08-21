import type { SessionSource } from "@/support/session-identity";

// A session whose name a test can assert on, and one a test can advance by
// hand — the recorders only ever ask which session they are in.
export function sessionNamed(name: string): SessionSource {
	return { current: () => name };
}

export function rollingSession(names: string[]): SessionSource {
	let index = 0;
	return {
		current: () => names[Math.min(index++, names.length - 1)] ?? "",
	};
}
