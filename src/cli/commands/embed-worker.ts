import { runEmbedWorker } from "@/embedding/worker";

export async function runEmbedWorkerCommand(): Promise<number> {
	await runEmbedWorker();
	return 0;
}
