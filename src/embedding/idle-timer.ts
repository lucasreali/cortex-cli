export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// The model costs hundreds of megabytes of resident memory, so both the
// private worker and the daemon give it back after a quiet spell and pay the
// reload on the next request. A non-positive timeout means never.
export class IdleTimer {
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS) {}

	arm(onIdle: () => void): void {
		this.clear();
		if (this.timeoutMs <= 0) return;
		this.timer = setTimeout(onIdle, this.timeoutMs);
		this.timer.unref?.();
	}

	clear(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
}
