// The tail the next unit waits on resolves whether the current one succeeded
// or failed, so a rejection neither breaks the chain nor surfaces as
// unhandled: the caller owns the promise `run` hands back.
export class SerialLane {
	private tail: Promise<unknown>;

	constructor() {
		this.tail = Promise.resolve();
	}

	run<T>(work: () => Promise<T>): Promise<T> {
		const settled = Promise.withResolvers<unknown>();
		const started = this.tail.then(work);
		this.tail = settled.promise;
		started.then(settled.resolve, settled.resolve);
		return started;
	}
}
