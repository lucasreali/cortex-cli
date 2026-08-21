// A promise nothing can cancel still has to stop being waited on: the work runs
// to completion in the background, the caller is told it took too long. Callers
// that own the work pass onTimeout to tear it down; callers that share it (a
// reconcile another request will reuse, a model still loading) leave it alone.
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
