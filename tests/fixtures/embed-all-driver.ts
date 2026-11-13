// Drives embedAll against a hung provider so the timeout path can be
// exercised without a real embedding worker. Usage: bun embed-all-driver.ts
// <store-dir> [flaky]; prints "disposed" when the timeout kills the provider and
// "pending:<n>" with the decisions still missing a vector. "flaky" seeds three
// decisions and a provider that fails any request containing the second.
import { embedAll } from "@/cli/commands/embed-all";
import type { EmbeddingProvider } from "@/embedding/provider";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository } from "@/storage/node-repository";
import { seedDecision } from "@tests/support/seed";

const dir = process.argv[2];
if (!dir) throw new Error("usage: embed-all-driver.ts <store-dir>");

const db = openDecisionsDb(dir);
migrate(db);
db.query("INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')").run();
db.query("INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')").run();
const nodes = new NodeRepository(db);
const embeddings = new EmbeddingRepository(db);

const decision = seedDecision(dir, db, {
		title: "Adotar JWT para autenticação",
		body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
		keywords: ["autenticação", "authentication", "jwt", "login", "token"],
	},
	{
		projectId: "project-1",
		sessionId: "session-1",
		commitSha: null,
		commitDirty: false,
	},
);

const flaky = process.argv[3] === "flaky";
const seeded = [decision];
if (flaky) {
	for (const title of ["Decisão que o provider recusa", "Terceira decisão"]) {
		seeded.push(
			seedDecision(
				dir,
				db,
				{ ...decisionInput(), title },
				{
					projectId: "project-1",
					sessionId: "session-1",
					commitSha: null,
					commitDirty: false,
				},
			),
		);
	}
}

function decisionInput() {
	return {
		title: "Adotar JWT para autenticação",
		body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
		keywords: ["autenticação", "authentication", "jwt", "login", "token"],
	};
}

const flakyProvider: EmbeddingProvider = {
	modelId: "hung-model@4",
	embedQuery: () => Promise.reject(new Error("unused")),
	embedPassages: (texts) =>
		texts.some((text) => text.includes("recusa"))
			? Promise.reject(new Error("worker refused"))
			: Promise.resolve(texts.map(() => new Float32Array([1, 0, 0, 0]))),
};

const hungProvider: EmbeddingProvider = {
	modelId: "hung-model@4",
	embedQuery: () => new Promise(() => {}),
	embedPassages: () => new Promise(() => {}),
	dispose: () => console.log("disposed"),
};

const code = await embedAll(
	{ nodes, embeddings, provider: flaky ? flakyProvider : hungProvider },
	seeded.map((entry) => entry.id),
	50,
);
console.log(`pending:${embeddings.listMissingNodeIds("hung-model@4").length}`);
db.close();
process.exit(code);
