/**
 * Smoke test 0.2 — EmbeddingGemma no Bun via @huggingface/transformers (WASM).
 *
 * Valida: carga do modelo quantizado, embedding de frases PT técnicas,
 * truncamento Matryoshka para 256 dims + renormalização, cosine entre pares,
 * efeito dos prompts de tarefa (query vs. documento), latência e RSS.
 *
 * Rodar: bun scripts/smoke-embedding.ts
 * Variantes: SMOKE_MODEL=gemma|e5  SMOKE_DTYPE=q8|q4|fp32  SMOKE_ARENA=0
 *
 * ── Números medidos em 2026-07-16 (Bun 1.3.14, Linux x64 WSL2, 12 cores) ──
 *
 * gemma q8 (single-thread WASM; multi-thread não roda no Bun, ver nota
 * no numThreads; q4 falha: GatherBlockQuantized não existe no EP wasm):
 *   latência média 600–627 ms/texto (pós warm-up), máx 850 ms  → FALHA (<500)
 *   RSS após carga 1.48–2.24 GB (arena on/off quase indiferente) → FALHA (<600 MB)
 *   semântica OK: relacionados 0.63–0.70 vs. não relacionados 0.37–0.48;
 *   prefixo de query melhora a separação (gap 0.42 vs. 0.39 sem prefixo)
 *
 * e5-small q8 (plano B, spec §2.4):
 *   latência média 151 ms  → PASSA
 *   RSS ~1.2 GB            → FALHA
 *   semântica: baseline de cosine comprimido (relacionados ~0.90 vs. não
 *   relacionados 0.86–0.90; fp32 idêntico → não é efeito de quantização)
 *
 * Teste de ranking (5 queries PT → doc esperado, ambos q8):
 *   gemma: 5/5 top-1, gap p/ 2º entre 0.040 e 0.218 (margens robustas)
 *   e5:    5/5 top-1, gap p/ 2º entre 0.007 e 0.031 (margens finas)
 *
 * Conclusão: a runtime WASM funciona no Bun sem crash e sem dependência
 * nativa; ambos os modelos ranqueiam 5/5 neste corpus. O gemma tem margens
 * de ranking 5–20× maiores; o e5 é ~7× mais rápido e usa metade da RAM.
 * Nenhum cumpre o RSS < 600 MB in-process: o número é dominado pelo heap
 * Emscripten do onnxruntime-web (cresce na inicialização e não devolve ao
 * SO). Decisão titular vs. plano B escalada ao humano — ver todo.md §0.2.
 */
// transformers.js v4 escolhe onnxruntime-node (nativo) quando
// process.release.name === "node" — e Bun se apresenta como "node".
// Renomear antes do import força o caminho web (onnxruntime WASM),
// que é o backend exigido pela spec (nenhuma dependência nativa).
process.release.name = "bun";
const { pipeline, env } = await import("@huggingface/transformers");

if (!env.backends.onnx?.wasm) {
	throw new Error("backend WASM do onnxruntime indisponível");
}
env.backends.onnx.wasm.wasmPaths = new URL(
	"../node_modules/onnxruntime-web/dist/",
	import.meta.url,
).href;
// > 1 thread não funciona no Bun: os pthread workers do Emscripten são
// carregados via blob URL, que o worker_threads do Bun não resolve.
env.backends.onnx.wasm.numThreads = 1;

// Prompts de tarefa conforme o model card de cada modelo.
const MODELS = {
	gemma: {
		id: "onnx-community/embeddinggemma-300m-ONNX",
		dims: 256, // Matryoshka: truncar de 768 → 256
		queryPrefix: "task: search result | query: ",
		documentPrefix: "title: none | text: ",
	},
	e5: {
		id: "Xenova/multilingual-e5-small",
		dims: 384, // dimensão nativa, sem truncamento
		queryPrefix: "query: ",
		documentPrefix: "passage: ",
	},
} as const;

const MODEL =
	MODELS[(process.env.SMOKE_MODEL ?? "gemma") as keyof typeof MODELS];
const DTYPE = (process.env.SMOKE_DTYPE ?? "q8") as "q8" | "q4" | "fp32";

const MODEL_ID = MODEL.id;
const TARGET_DIMS = MODEL.dims;
const QUERY_PREFIX = MODEL.queryPrefix;
const DOCUMENT_PREFIX = MODEL.documentPrefix;

const SENTENCES = [
	"optamos por JWT stateless para autenticação de usuários",
	"os tokens de acesso expiram em quinze minutos e usamos refresh tokens",
	"escolhemos PostgreSQL como banco de dados principal do projeto",
	"as migrations do banco rodam automaticamente no deploy",
	"o cache de sessões fica no Redis com TTL de uma hora",
	"usamos filas no RabbitMQ para processar emails em background",
	"o frontend consome a API REST paginada com cursor",
	"logs estruturados em JSON são enviados para o Elasticsearch",
	"o CI roda testes de integração contra containers efêmeros",
	"a receita de bolo de cenoura leva três ovos e cobertura de chocolate",
];

const RELATED_PAIRS: Array<[number, number]> = [
	[0, 1], // JWT ↔ tokens de acesso
	[2, 3], // PostgreSQL ↔ migrations
];
const UNRELATED_PAIRS: Array<[number, number]> = [
	[0, 9], // JWT ↔ bolo de cenoura
	[4, 9], // Redis ↔ bolo de cenoura
	[0, 5], // JWT ↔ RabbitMQ
];

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += (a[i] as number) * (b[i] as number);
	}
	return dot;
}

function truncateAndNormalize(
	vector: Float32Array,
	dims: number,
): Float32Array {
	const truncated = vector.slice(0, dims);
	let sumOfSquares = 0;
	for (const value of truncated) {
		sumOfSquares += value * value;
	}
	const norm = Math.sqrt(sumOfSquares);
	return truncated.map((value) => value / norm);
}

function formatMb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function logRss(label: string): void {
	Bun.gc(true);
	console.log(`  [mem] ${label}: RSS ${formatMb(process.memoryUsage().rss)}`);
}

logRss("antes da carga do modelo");
console.log(`Carregando ${MODEL_ID} (WASM, dtype=${DTYPE})...`);
const loadStart = performance.now();
const extractor = await pipeline("feature-extraction", MODEL_ID, {
	device: "wasm",
	dtype: DTYPE,
	session_options: {
		enableCpuMemArena: process.env.SMOKE_ARENA !== "0",
		enableMemPattern: process.env.SMOKE_ARENA !== "0",
	},
});
console.log(
	`Modelo carregado em ${((performance.now() - loadStart) / 1000).toFixed(1)} s`,
);
logRss("após carga do modelo");

async function embed(text: string): Promise<Float32Array> {
	const output = await extractor(text, { pooling: "mean", normalize: true });
	return truncateAndNormalize(output.data as Float32Array, TARGET_DIMS);
}

console.log("\nWarm-up...");
await embed(`${DOCUMENT_PREFIX}warm-up`);

console.log(
	`\nEmbeddando ${SENTENCES.length} frases (prefixo de documento), medindo latência:`,
);
const vectors: Float32Array[] = [];
const latencies: number[] = [];
for (const sentence of SENTENCES) {
	const start = performance.now();
	vectors.push(await embed(DOCUMENT_PREFIX + sentence));
	const elapsed = performance.now() - start;
	latencies.push(elapsed);
	console.log(
		`  ${elapsed.toFixed(0).padStart(4)} ms | ${sentence.slice(0, 60)}`,
	);
}

console.log("\nCosine entre pares relacionados:");
for (const [i, j] of RELATED_PAIRS) {
	const score = cosine(vectors[i] as Float32Array, vectors[j] as Float32Array);
	console.log(`  ${score.toFixed(4)} | [${i}] × [${j}]`);
}
console.log("Cosine entre pares NÃO relacionados:");
for (const [i, j] of UNRELATED_PAIRS) {
	const score = cosine(vectors[i] as Float32Array, vectors[j] as Float32Array);
	console.log(`  ${score.toFixed(4)} | [${i}] × [${j}]`);
}

console.log(
	"\nEfeito do prompt de tarefa (query 'como autenticamos usuários?' vs. docs):",
);
const question = "como autenticamos usuários?";
const withPrefix = await embed(QUERY_PREFIX + question);
const withoutPrefix = await embed(question);
const jwtDoc = vectors[0] as Float32Array;
const cakeDoc = vectors[9] as Float32Array;
console.log(
	`  com prefixo    → doc JWT: ${cosine(withPrefix, jwtDoc).toFixed(4)} | doc bolo: ${cosine(withPrefix, cakeDoc).toFixed(4)}`,
);
console.log(
	`  sem prefixo    → doc JWT: ${cosine(withoutPrefix, jwtDoc).toFixed(4)} | doc bolo: ${cosine(withoutPrefix, cakeDoc).toFixed(4)}`,
);

// ── Teste de ranking (decide titular vs. plano B, ver conversa 0.2) ──
// Busca é problema de ranking, não de gap absoluto de cosine: o e5 tem
// baseline comprimido (~0.86+ para tudo), mas se o doc correto vence os
// errados de forma consistente, o modelo serve. Aceite: 5/5 no top-1,
// ou 5/5 no top-3 com pelo menos 4 no top-1.
const RANKING_QUERIES: Array<{ query: string; expectedDoc: number }> = [
	{ query: "como autenticamos usuários?", expectedDoc: 0 },
	{ query: "qual banco de dados usamos?", expectedDoc: 2 },
	{ query: "onde ficam guardadas as sessões?", expectedDoc: 4 },
	{ query: "como enviamos emails assíncronos?", expectedDoc: 5 },
	{ query: "para onde vão os logs da aplicação?", expectedDoc: 7 },
];

console.log("\nTeste de ranking (query → posição do doc esperado):");
let top1 = 0;
let top3 = 0;
for (const { query, expectedDoc } of RANKING_QUERIES) {
	const queryVector = await embed(QUERY_PREFIX + query);
	const ranked = vectors
		.map((doc, index) => ({ index, score: cosine(queryVector, doc) }))
		.sort((a, b) => b.score - a.score);
	const position = ranked.findIndex((entry) => entry.index === expectedDoc) + 1;
	if (position === 1) top1++;
	if (position <= 3) top3++;
	const gapToNext =
		position === 1
			? ((ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0)).toFixed(4)
			: "—";
	console.log(`  pos ${position} | gap p/ 2º: ${gapToNext} | ${query}`);
}
const rankingPass = top1 === 5 || (top3 === 5 && top1 >= 4);
console.log(
	`  → top-1: ${top1}/5 | top-3: ${top3}/5 | ${rankingPass ? "PASSA" : "FALHA"}`,
);

Bun.gc(true);
const memory = process.memoryUsage();
const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
const maxLatency = Math.max(...latencies);
console.log("\nResumo:");
console.log(
	`  latência média por texto (pós warm-up): ${avgLatency.toFixed(0)} ms`,
);
console.log(`  latência máxima: ${maxLatency.toFixed(0)} ms`);
console.log(
	`  RSS: ${formatMb(memory.rss)} | heapUsed: ${formatMb(memory.heapUsed)}`,
);
console.log(`  dims: ${TARGET_DIMS} (renormalizado após truncar)`);
