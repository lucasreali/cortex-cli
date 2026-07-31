import { describe, expect, test } from "bun:test";
import { SerialLane } from "@/embedding/serial-lane";

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
