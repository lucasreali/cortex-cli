import { runEmbeddingDaemon } from "@/embedding/daemon/main";
import { GEMMA_MODEL } from "@/embedding/model";

export function runEmbedDaemonCommand(args: string[]): Promise<number> {
	return runEmbeddingDaemon(args[0] ?? GEMMA_MODEL.modelId);
}
