export interface EvalCase {
	id: string;
	query: string;
	expected: string[];
}

const MODEL_ID_CARRIES_DTYPE = "019f6dc3-e745-7000-9666-7e7381cc5f62";
const CONFIG_SOURCE_OF_TRUTH = "019f6dc3-e75c-7000-95ec-33984af962be";
const EMBED_QUEUE_TIMEOUT = "019f6dc3-e766-7000-a1a9-63a18e8029f1";
const SEARCH_DEGRADES_TO_FTS = "019f6dc3-e770-7000-805d-64094a4aec70";
const HYBRID_SEARCH_ADOPTED = "019f8c23-56ca-7000-87e2-a7607c354f2f";
const SPEC_RECOVERED_FROM_TRANSCRIPTS = "019f86dc-9878-7000-8907-d39b91633fc4";
const CODE_DB_MIGRATION_RUNNER = "019f86dc-9882-7000-81b1-e81751abbfb4";
const WALKER_GIT_LS_FILES = "019f86ed-b7fb-7000-ba43-73cff203fffe";
const TSX_EXTRACTION_KINDS = "019f86ed-b804-7000-bcdb-b70e495ad1eb";
const IMPORT_RESOLUTION_PROVENANCE = "019f86f3-d1d4-7000-b2ce-c08b3cd5f95c";
const INDEX_FULL_OR_INCREMENTAL = "019f86fe-289d-7000-a3fc-eadff7832d5a";
const DOCTOR_NON_MUTATING = "019f8703-c99d-7000-9c1b-d9352acafcd3";
const IMPACT_PESSIMISTIC_PROVENANCE = "019f871e-e962-7000-8617-cada93deeafd";
const SYMBOL_ANCHOR_SUGGESTIONS = "019f871e-e969-7000-b4a8-f292a9b1e29e";
const CLI_IMPACT_PARITY = "019f8732-abea-7000-8776-707b0ed05597";
const APP_LAYER_COMPOSITION_ROOT = "019f874c-5429-7000-8ad2-8ca97eb71949";
const INDEXING_OPTIMIZATIONS_REJECTED = "019f8aaf-9e4d-7000-b73f-6b6a367c0869";
const NO_FILE_WATCHER = "019f8aaf-9e54-7000-a55f-33e6857eae2f";
const INIT_GITIGNORES_CORTEX = "019f8ab8-5de0-7000-baa0-797e10ac3ed2";
const PROMPT_HOOK_TIER_GATE = "019f8ba3-d013-7000-bc25-bbcf1d7bfd42";
const MCP_MULTI_PROJECT = "019f8bbd-1e5f-7000-b3df-5e6c26ffaf09";
const MCP_GUIDANCE_NOT_ERROR = "019f8bd4-1c36-7000-bb67-daa5e0deae5d";
const EXTRACTION_VERSION_REBUILD = "019f8be9-d3a3-7000-a3a9-13613a6fdb53";

export const GROUND_TRUTH: EvalCase[] = [
	{
		id: "model-dtype-pt",
		query:
			"por que o identificador do modelo de embedding inclui a quantização?",
		expected: [MODEL_ID_CARRIES_DTYPE],
	},
	{
		id: "model-dtype-en",
		query: "embedding model id dtype q8 dims",
		expected: [MODEL_ID_CARRIES_DTYPE],
	},
	{
		id: "provider-source-pt",
		query: "de onde o runtime tira qual modelo de embedding carregar?",
		expected: [CONFIG_SOURCE_OF_TRUTH],
	},
	{
		id: "provider-source-en",
		query: "which config pins the embedding model for the whole store",
		expected: [CONFIG_SOURCE_OF_TRUTH],
	},
	{
		id: "queue-hang-pt",
		query: "worker de embedding travou no meio da fila, e agora?",
		expected: [EMBED_QUEUE_TIMEOUT],
	},
	{
		id: "queue-hang-en",
		query: "what happens when an embed job hangs for too long",
		expected: [EMBED_QUEUE_TIMEOUT],
	},
	{
		id: "cold-start-pt",
		query: "primeira busca depois de muito tempo parado responde por keyword?",
		expected: [SEARCH_DEGRADES_TO_FTS],
	},
	{
		id: "cold-start-en",
		query: "query embedding timeout during search fallback",
		expected: [SEARCH_DEGRADES_TO_FTS],
	},
	{
		id: "fusion-pt",
		query: "por que somamos os scores do bm25 com o cosseno na busca?",
		expected: [HYBRID_SEARCH_ADOPTED],
	},
	{
		id: "fusion-en",
		query: "reciprocal rank fusion rrf adoption evidence",
		expected: [HYBRID_SEARCH_ADOPTED],
	},
	{
		id: "spec-missing-pt",
		query: "cadê o arquivo de spec do cortex? não acho no repositório",
		expected: [SPEC_RECOVERED_FROM_TRANSCRIPTS],
	},
	{
		id: "spec-missing-en",
		query: "canonical DDL reference now that the spec file is gone",
		expected: [SPEC_RECOVERED_FROM_TRANSCRIPTS],
	},
	{
		id: "code-db-upsert-pt",
		query: "reindexar um arquivo apaga e regrava os símbolos dele?",
		expected: [CODE_DB_MIGRATION_RUNNER],
	},
	{
		id: "code-db-migrations-en",
		query: "does code.db use the same migration runner as decisions.db",
		expected: [CODE_DB_MIGRATION_RUNNER],
	},
	{
		id: "walker-untracked-pt",
		query: "arquivo novo ainda sem commit entra no índice de código?",
		expected: [WALKER_GIT_LS_FILES],
	},
	{
		id: "walker-gitignore-en",
		query: "how the indexer respects gitignore when listing source files",
		expected: [WALKER_GIT_LS_FILES],
	},
	{
		id: "extractor-methods-pt",
		query: "como métodos de classe ficam nomeados no índice de símbolos?",
		expected: [TSX_EXTRACTION_KINDS],
	},
	{
		id: "extractor-require-en",
		query: "are require calls and re-exports captured by the extractor",
		expected: [TSX_EXTRACTION_KINDS],
	},
	{
		id: "resolver-provenance-pt",
		query: "quando um import resolvido conta como exact em vez de heuristic?",
		expected: [IMPORT_RESOLUTION_PROVENANCE],
	},
	{
		id: "resolver-jsonc-en",
		query: "tsconfig with comments breaks path alias parsing?",
		expected: [IMPORT_RESOLUTION_PROVENANCE],
	},
	{
		id: "index-mode-pt",
		query: "o que faz o cortex index escolher entre completo e incremental?",
		expected: [INDEX_FULL_OR_INCREMENTAL, EXTRACTION_VERSION_REBUILD],
	},
	{
		id: "index-touch-en",
		query: "touched file without content change, does it re-extract",
		expected: [INDEX_FULL_OR_INCREMENTAL],
	},
	{
		id: "doctor-read-only-pt",
		query: "por que o doctor só aponta o drift e não conserta o índice?",
		expected: [DOCTOR_NON_MUTATING],
	},
	{
		id: "doctor-rate-en",
		query: "which imports count in the resolution rate the doctor reports",
		expected: [DOCTOR_NON_MUTATING],
	},
	{
		id: "impact-depth-pt",
		query:
			"impacto por imports transitivos usa qual profundidade e como propaga a confiança?",
		expected: [IMPACT_PESSIMISTIC_PROVENANCE],
	},
	{
		id: "impact-chain-en",
		query: "blast radius through the import chain, one heuristic hop taints it",
		expected: [IMPACT_PESSIMISTIC_PROVENANCE],
	},
	{
		id: "anchor-typo-pt",
		query: "salvei uma decisão com símbolo que não existe, ela é rejeitada?",
		expected: [SYMBOL_ANCHOR_SUGGESTIONS],
	},
	{
		id: "anchor-suggest-en",
		query: "did you mean suggestions for a wrong anchor symbol",
		expected: [SYMBOL_ANCHOR_SUGGESTIONS],
	},
	{
		id: "cli-parity-pt",
		query: "o impact da linha de comando mostra o mesmo que a tool do agente?",
		expected: [CLI_IMPACT_PARITY],
	},
	{
		id: "schema-describe-en",
		query: "every save_decision schema field carries a describe",
		expected: [CLI_IMPACT_PARITY],
	},
	{
		id: "app-layer-pt",
		query:
			"onde fica o composition root compartilhado entre a CLI e o servidor?",
		expected: [APP_LAYER_COMPOSITION_ROOT],
	},
	{
		id: "app-layer-en",
		query: "why did buildRuntime move out of the mcp folder",
		expected: [APP_LAYER_COMPOSITION_ROOT],
	},
	{
		id: "rust-kernel-pt",
		query: "vale portar a indexação para um kernel nativo em rust?",
		expected: [INDEXING_OPTIMIZATIONS_REJECTED],
	},
	{
		id: "wal-tuning-en",
		query: "wal checkpoint valve and index drop windows for bulk load",
		expected: [INDEXING_OPTIMIZATIONS_REJECTED],
	},
	{
		id: "watcher-pt",
		query: "por que não tem inotify mantendo o índice de código fresco?",
		expected: [NO_FILE_WATCHER],
	},
	{
		id: "watcher-en",
		query: "keeping the code index up to date automatically when files change",
		expected: [NO_FILE_WATCHER, INDEX_FULL_OR_INCREMENTAL],
	},
	{
		id: "gitignore-pt",
		query: "devo commitar o decisions.db no repositório?",
		expected: [INIT_GITIGNORES_CORTEX],
	},
	{
		id: "gitignore-en",
		query: "cortex init gitignore entries",
		expected: [INIT_GITIGNORES_CORTEX],
	},
	{
		id: "hook-inject-pt",
		query: "quando o hook de prompt injeta contexto sozinho?",
		expected: [PROMPT_HOOK_TIER_GATE],
	},
	{
		id: "hook-noise-en",
		query: "avoiding noisy auto injection of decisions on unrelated prompts",
		expected: [PROMPT_HOOK_TIER_GATE],
	},
	{
		id: "multi-repo-pt",
		query: "um servidor só atende vários repositórios com store próprio?",
		expected: [MCP_MULTI_PROJECT],
	},
	{
		id: "multi-repo-en",
		query: "why cache the runtime by resolved root instead of the input path",
		expected: [MCP_MULTI_PROJECT],
	},
	{
		id: "not-init-pt",
		query: "tool deve responder erro quando o projeto não foi inicializado?",
		expected: [MCP_GUIDANCE_NOT_ERROR, MCP_MULTI_PROJECT],
	},
	{
		id: "readonly-hint-en",
		query: "readOnlyHint annotations on the read tools",
		expected: [MCP_GUIDANCE_NOT_ERROR],
	},
	{
		id: "stale-extractor-pt",
		query:
			"mudei a saída do extractor, os índices antigos se corrigem sozinhos?",
		expected: [EXTRACTION_VERSION_REBUILD],
	},
	{
		id: "stale-extractor-en",
		query: "stale code index after extractor change forces full rebuild",
		expected: [EXTRACTION_VERSION_REBUILD],
	},
];
