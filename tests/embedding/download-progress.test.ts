import { describe, expect, test } from "bun:test";
import { DownloadProgress } from "@/embedding/download-progress";

const MEGABYTE = 1024 * 1024;
const WEIGHTS = 300 * MEGABYTE;

describe("DownloadProgress", () => {
	test("reports one line per whole step of a large file", () => {
		const progress = new DownloadProgress();
		const lines = [0.02, 0.05, 0.11, 0.14, 0.23, 1]
			.map((fraction) =>
				progress.line({
					file: "onnx/model_quantized.onnx",
					loaded: WEIGHTS * fraction,
					total: WEIGHTS,
				}),
			)
			.filter((line) => line !== null);

		expect(lines).toEqual([
			"[cortex] downloading model: onnx/model_quantized.onnx 0% of 300 MB",
			"[cortex] downloading model: onnx/model_quantized.onnx 10% of 300 MB",
			"[cortex] downloading model: onnx/model_quantized.onnx 20% of 300 MB",
			"[cortex] downloading model: onnx/model_quantized.onnx 100% of 300 MB",
		]);
	});

	test("each file keeps its own steps", () => {
		const progress = new DownloadProgress();
		const weights = { file: "weights", loaded: WEIGHTS, total: WEIGHTS };
		const data = { file: "data", loaded: WEIGHTS / 2, total: WEIGHTS };
		expect(progress.line(weights)).toContain("weights 100%");
		expect(progress.line(data)).toContain("data 50%");
		expect(progress.line(weights)).toBeNull();
	});

	test("a file too small to wonder about is never reported", () => {
		const progress = new DownloadProgress();
		expect(
			progress.line({ file: "config.json", loaded: 500, total: 1000 }),
		).toBeNull();
		expect(
			progress.line({
				file: "tokenizer_config.json",
				loaded: MEGABYTE,
				total: MEGABYTE,
			}),
		).toBeNull();
	});

	test("an event with no file or no size says nothing", () => {
		const progress = new DownloadProgress();
		expect(progress.line({ loaded: WEIGHTS, total: WEIGHTS })).toBeNull();
		expect(progress.line({ file: "weights" })).toBeNull();
	});
});
