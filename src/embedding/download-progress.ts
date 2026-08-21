export interface DownloadProgressEvent {
	file?: string;
	loaded?: number;
	total?: number;
}

// transformers.js reports every chunk of every file it fetches, which over
// ~300 MB is thousands of events. Whole steps of this size are what a person
// watching a first run needs, and only for the two files whose absence would
// read as a hang — the tokenizer and the weights, everything else is small enough
// to arrive between two lines.
const REPORT_STEP_PERCENT = 10;
const WORTH_REPORTING_BYTES = 8 * 1024 * 1024;
const BYTES_PER_MEGABYTE = 1024 * 1024;

// The download happens inside the worker, whose stderr the parent inherits, so
// these lines reach the terminal that ran `cortex embed` without crossing the
// NDJSON channel the vectors travel on.
export class DownloadProgress {
	private readonly reported: Map<string, number>;

	constructor() {
		this.reported = new Map();
	}

	// Returns the line worth showing, or null when this event says nothing the
	// last one did not.
	line(event: DownloadProgressEvent): string | null {
		const { file, loaded = 0, total = 0 } = event;
		if (!file || total < WORTH_REPORTING_BYTES) return null;
		const step = Math.floor(loaded / total / (REPORT_STEP_PERCENT / 100));
		if (step <= (this.reported.get(file) ?? -1)) return null;
		this.reported.set(file, step);
		const megabytes = Math.round(total / BYTES_PER_MEGABYTE);
		const percent = Math.min(step * REPORT_STEP_PERCENT, 100);
		return `[cortex] downloading model: ${file} ${percent}% of ${megabytes} MB`;
	}
}
