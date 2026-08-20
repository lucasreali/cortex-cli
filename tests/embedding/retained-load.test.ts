import { describe, expect, test } from "bun:test";
import { RetainedLoad } from "@/embedding/retained-load";

describe("RetainedLoad", () => {
	test("loads once and hands every caller the same value", async () => {
		let loads = 0;
		const load = new RetainedLoad(() => {
			loads++;
			return Promise.resolve("model");
		});

		const [first, second] = await Promise.all([load.get(), load.get()]);
		expect(await load.get()).toBe("model");
		expect([first, second]).toEqual(["model", "model"]);
		expect(loads).toBe(1);
	});

	test("a rejected load is not memoised, so the next caller retries", async () => {
		let attempts = 0;
		const load = new RetainedLoad(() => {
			attempts++;
			return attempts === 1
				? Promise.reject(new Error("503 from the model CDN"))
				: Promise.resolve("model");
		});

		expect(load.get()).rejects.toThrow("503 from the model CDN");
		await Bun.sleep(0);
		expect(await load.get()).toBe("model");
		expect(attempts).toBe(2);
	});

	test("callers waiting on one failing load all see that failure", async () => {
		let attempts = 0;
		const load = new RetainedLoad(() => {
			attempts++;
			return Promise.reject(new Error("wasm backend unavailable"));
		});

		const results = await Promise.allSettled([load.get(), load.get()]);
		expect(results.map((result) => result.status)).toEqual([
			"rejected",
			"rejected",
		]);
		expect(attempts).toBe(1);
		expect(load.get()).rejects.toThrow("wasm backend unavailable");
		await Bun.sleep(0);
		expect(attempts).toBe(2);
	});
});
