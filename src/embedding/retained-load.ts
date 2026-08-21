// `promise ??= load()` memoises a rejection exactly as happily as a value: the
// operators only reassign on null or undefined, and a rejected promise is
// neither. One transient DNS failure, a 503 from the model CDN or a wasm
// backend that was not ready would then answer every later request for the
// life of the process — and this process is a worker that outlives hundreds of
// them, or a daemon shared by every session on the machine. Only a load that
// succeeded is worth keeping.
export class RetainedLoad<T> {
	private retained: Promise<T> | null = null;

	constructor(private readonly load: () => Promise<T>) {}

	get(): Promise<T> {
		this.retained ??= this.load().catch((error) => {
			this.retained = null;
			throw error;
		});
		return this.retained;
	}
}
