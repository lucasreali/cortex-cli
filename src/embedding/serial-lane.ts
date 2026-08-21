// One worker embeds one request at a time, so a lane deeper than this is
// already longer than the deadline of everything waiting in it: the caller is
// better served by its own private worker than by a place in the queue.
export const DEFAULT_LANE_DEPTH = 8;

// The tail the next unit waits on resolves whether the current one succeeded
// or failed, so a rejection neither breaks the chain nor surfaces as
// unhandled: the caller owns the promise `run` hands back.
export class SerialLane {
	private tail: Promise<unknown> = Promise.resolve();
	private waiting = 0;

	constructor(private readonly maxDepth: number = DEFAULT_LANE_DEPTH) {}

	get depth(): number {
		return this.waiting;
	}

	get full(): boolean {
		return this.waiting >= this.maxDepth;
	}

	run<T>(work: () => Promise<T>): Promise<T> {
		const settled = Promise.withResolvers<unknown>();
		this.waiting++;
		const started = this.tail.then(work);
		this.tail = settled.promise;
		started.then(
			(value) => this.release(settled, value),
			(error) => this.release(settled, error),
		);
		return started;
	}

	private release(settled: PromiseWithResolvers<unknown>, outcome: unknown) {
		this.waiting--;
		settled.resolve(outcome);
	}
}
