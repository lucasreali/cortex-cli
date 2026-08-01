// Shape validation stays with the caller, which is the only place that knows
// what the parsed value has to look like.
export function parseJsonOrNull<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}
