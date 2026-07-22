import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord } from "@/domain";
import { decisionFileName, serializeDecisionFile } from "./decision-file";

export interface DecisionFileContent {
	hash: string;
	content: string;
}

export interface WrittenDecisionFile {
	fileName: string;
	hash: string;
}

export class DecisionFileStore {
	constructor(private readonly directory: string) {}

	exists(): boolean {
		return existsSync(this.directory);
	}

	async snapshot(): Promise<Map<string, DecisionFileContent>> {
		const entries = new Map<string, DecisionFileContent>();
		if (!this.exists()) return entries;
		for (const fileName of this.listFileNames()) {
			const content = await Bun.file(join(this.directory, fileName)).text();
			entries.set(fileName, { hash: contentHash(content), content });
		}
		return entries;
	}

	async write(record: DecisionRecord): Promise<WrittenDecisionFile> {
		mkdirSync(this.directory, { recursive: true });
		const fileName = decisionFileName(record.decision.id);
		const content = serializeDecisionFile(record);
		await Bun.write(join(this.directory, fileName), content);
		return { fileName, hash: contentHash(content) };
	}

	private listFileNames(): string[] {
		return readdirSync(this.directory).filter((name) => name.endsWith(".md"));
	}
}

function contentHash(content: string): string {
	return Bun.hash(content).toString(16);
}
