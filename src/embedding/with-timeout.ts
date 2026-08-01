// A hung worker must never wedge the caller: on timeout the provider is
// disposed, which kills the subprocess so the next request respawns it, and
// the work is reported as failed rather than left hanging.
//
// The query path deliberately does NOT use this (see semantic-search.ts): a
// model still loading after an idle-kill is left alone so it finishes for the
// next query instead of restarting, and FTS answers meanwhile.
export function disposingOnTimeout<T>(
	provider: { dispose?(): void },
	work: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return withTimeout(work, timeoutMs, () => provider.dispose?.());
}

export function withTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
