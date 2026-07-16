/**
 * Smoke test 0.3 — web-tree-sitter no Bun.
 *
 * Valida: carga da gramática TSX de um .wasm local (release oficial do
 * tree-sitter-typescript, cache global ~/.cortex/grammars/ com download
 * lazy + verificação de sha256 — nenhuma dependência nativa; o pacote
 * tree-sitter-wasms foi descartado: gramáticas da era 0.20, formato
 * dylink incompatível com o web-tree-sitter 0.26), parse de 5 arquivos
 * reais do repositório, extração de imports (specifier) e de declarações
 * de símbolo (função, classe, método, arrow function nomeada).
 *
 * Rodar: bun scripts/smoke-treesitter.ts
 */
import { Language, Parser, Query } from "web-tree-sitter";

const GRAMMAR_URL =
	"https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm";
const GRAMMAR_SHA256 =
	"79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8";
const GRAMMAR_PATH = `${process.env.HOME}/.cortex/grammars/tree-sitter-tsx.wasm`;

async function ensureGrammar(): Promise<void> {
	const cached = Bun.file(GRAMMAR_PATH);
	if (!(await cached.exists())) {
		console.log(`Baixando gramática TSX para ${GRAMMAR_PATH}...`);
		const response = await fetch(GRAMMAR_URL);
		if (!response.ok) {
			throw new Error(`download da gramática falhou: HTTP ${response.status}`);
		}
		await Bun.write(GRAMMAR_PATH, response);
	}
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await cached.arrayBuffer());
	const digest = hasher.digest("hex");
	if (digest !== GRAMMAR_SHA256) {
		throw new Error(
			`sha256 da gramática não confere: esperado ${GRAMMAR_SHA256}, obtido ${digest}`,
		);
	}
}

await ensureGrammar();

const FILES = [
	"scripts/smoke-embedding.ts",
	"scripts/smoke-treesitter.ts",
	"tests/fixtures/treesitter/user-service.ts",
	"tests/fixtures/treesitter/handlers.ts",
	"tests/fixtures/treesitter/app.tsx",
];

const IMPORT_QUERY = `(import_statement source: (string (string_fragment) @specifier))`;

const SYMBOL_QUERIES: Array<{ kind: string; source: string }> = [
	{
		kind: "function",
		source: `(function_declaration name: (identifier) @name)`,
	},
	{
		kind: "class",
		source: `(class_declaration name: (type_identifier) @name)`,
	},
	{
		kind: "method",
		source: `(method_definition name: (property_identifier) @name)`,
	},
	{
		kind: "arrow",
		source: `(variable_declarator name: (identifier) @name value: (arrow_function))`,
	},
];

await Parser.init();
const language = await Language.load(GRAMMAR_PATH);
const parser = new Parser();
parser.setLanguage(language);

const importQuery = new Query(language, IMPORT_QUERY);
const symbolQueries = SYMBOL_QUERIES.map(({ kind, source }) => ({
	kind,
	query: new Query(language, source),
}));

for (const file of FILES) {
	const tree = parser.parse(await Bun.file(file).text());
	if (!tree) {
		throw new Error(`parse retornou null para ${file}`);
	}

	console.log(`\n── ${file}`);
	console.log("  imports:");
	for (const match of importQuery.matches(tree.rootNode)) {
		for (const capture of match.captures) {
			const line = capture.node.startPosition.row + 1;
			console.log(`    ${capture.node.text} | import | ${file} | L${line}`);
		}
	}
	console.log("  símbolos:");
	for (const { kind, query } of symbolQueries) {
		for (const match of query.matches(tree.rootNode)) {
			for (const capture of match.captures) {
				const line = capture.node.startPosition.row + 1;
				console.log(`    ${capture.node.text} | ${kind} | ${file} | L${line}`);
			}
		}
	}
}
