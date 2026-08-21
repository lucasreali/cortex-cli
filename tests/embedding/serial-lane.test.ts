import { describe, expect, test } from "bun:test";
import { DEFAULT_LANE_DEPTH, SerialLane } from "@/embedding/serial-lane";

interface Unit {
	started: boolean;
	run(): Promise<string>;
	resolve(value: string): void;
	reject(error: Error): void;
}

function makeUnit(): Unit {
	const gate = Promise.withResolvers<string>();
	const unit: Unit = {
		started: false,
		run: () => {
			unit.started = true;
			return gate.promise;
		},
		resolve: gate.resolve,
		reject: gate.reject,
	};
	return unit;
}

describe("SerialLane", () => {
	test("runs submitted work one unit at a time, in order", async () => {
		const lane = new SerialLane();
		const [first, second, third] = [makeUnit(), makeUnit(), makeUnit()];
		const results = [
			lane.run(first.run),
			lane.run(second.run),
			lane.run(third.run),
		];

		await Bun.sleep(0);
		expect([first.started, second.started, third.started]).toEqual([
			true,
			false,
			false,
		]);

		first.resolve("a");
		await Bun.sleep(0);
		expect([second.started, third.started]).toEqual([true, false]);

		second.resolve("b");
		third.resolve("c");
		expect(await Promise.all(results)).toEqual(["a", "b", "c"]);
	});

	// H16: an unbounded lane fills with requests whose callers timed out and
	// retried, and the daemon spends the worker on every one of them.
	test("reports itself full at its depth and empties as units settle", async () => {
		const lane = new SerialLane(2);
		const [first, second] = [makeUnit(), makeUnit()];
		expect(lane.full).toBe(false);

		const running = lane.run(first.run);
		const queued = lane.run(second.run);
		expect(lane.depth).toBe(2);
		expect(lane.full).toBe(true);

		first.resolve("a");
		await running;
		expect(lane.full).toBe(false);

		second.resolve("b");
		await queued;
		expect(lane.depth).toBe(0);
	});

	test("a rejected unit still frees its place in the lane", async () => {
		const lane = new SerialLane(1);
		const failing = makeUnit();
		const rejected = lane.run(failing.run);
		expect(lane.full).toBe(true);

		failing.reject(new Error("unit failed"));
		expect(rejected).rejects.toThrow("unit failed");
		await rejected.catch(() => {});
		expect(lane.full).toBe(false);
	});

	test("the default depth is what an unconfigured lane uses", () => {
		const lane = new SerialLane();
		for (let unit = 0; unit < DEFAULT_LANE_DEPTH; unit++) {
			expect(lane.full).toBe(false);
			void lane.run(makeUnit().run).catch(() => {});
		}
		expect(lane.full).toBe(true);
	});

	test("a rejected unit reaches its caller without wedging the lane", async () => {
		const lane = new SerialLane();
		const [failing, following] = [makeUnit(), makeUnit()];
		const rejected = lane.run(failing.run);
		const accepted = lane.run(following.run);

		failing.reject(new Error("unit failed"));
		expect(rejected).rejects.toThrow("unit failed");

		await Bun.sleep(0);
		expect(following.started).toBe(true);
		following.resolve("after");
		expect(await accepted).toBe("after");
	});
});
