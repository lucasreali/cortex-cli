import { Language, type Node, Parser, Query, type Tree } from "web-tree-sitter";
import type { CodeSymbol } from "@/domain";

export interface ExtractedSource {
	symbols: CodeSymbol[];
	imports: string[];
}

const IMPORT_PATTERNS = [
	"(import_statement source: (string (string_fragment) @specifier))",
	"(export_statement source: (string (string_fragment) @specifier))",
	`(call_expression
		function: (identifier) @callee
		arguments: (arguments (string (string_fragment) @specifier))
		(#eq? @callee "require"))`,
];

const SYMBOL_PATTERNS = [
	{
		kind: "function",
		pattern: "(function_declaration name: (identifier) @name)",
	},
	{
		kind: "class",
		pattern: "(class_declaration name: (type_identifier) @name)",
	},
	{
		kind: "arrow",
		pattern:
			"(variable_declarator name: (identifier) @name value: (arrow_function))",
	},
];

const METHOD_PATTERN = `(class_declaration
	name: (type_identifier) @owner
	body: (class_body (method_definition name: (property_identifier) @name)))`;

interface ExtractorQueries {
	imports: Query[];
	symbols: Array<{ kind: string; query: Query }>;
	methods: Query;
}

export class TsxExtractor {
	static async create(grammarPath: string): Promise<TsxExtractor> {
		await Parser.init();
		return new TsxExtractor(await Language.load(grammarPath));
	}

	private readonly parser: Parser;
	private readonly queries: ExtractorQueries;

	private constructor(language: Language) {
		this.parser = new Parser();
		this.parser.setLanguage(language);
		this.queries = {
			imports: IMPORT_PATTERNS.map((pattern) => new Query(language, pattern)),
			symbols: SYMBOL_PATTERNS.map(({ kind, pattern }) => ({
				kind,
				query: new Query(language, pattern),
			})),
			methods: new Query(language, METHOD_PATTERN),
		};
	}

	extract(sourceText: string): ExtractedSource {
		// parse() only returns null without a language set or on cancellation;
		// neither happens here, so the cast encodes that invariant.
		const root = (this.parser.parse(sourceText) as Tree).rootNode;
		return { symbols: this.symbolsOf(root), imports: this.importsOf(root) };
	}

	private symbolsOf(root: Node): CodeSymbol[] {
		const symbols = [...this.declarationsOf(root), ...this.methodsOf(root)];
		return symbols.sort(
			(a, b) => a.line - b.line || a.name.localeCompare(b.name),
		);
	}

	private declarationsOf(root: Node): CodeSymbol[] {
		return this.queries.symbols.flatMap(({ kind, query }) =>
			query
				.matches(root)
				.flatMap((match) => match.captures)
				.map((capture) => ({
					name: capture.node.text,
					kind,
					line: capture.node.startPosition.row + 1,
				})),
		);
	}

	private methodsOf(root: Node): CodeSymbol[] {
		return this.queries.methods.matches(root).map((match) => {
			const named = new Map(
				match.captures.map((capture) => [capture.name, capture.node]),
			);
			const owner = named.get("owner") as Node;
			const name = named.get("name") as Node;
			return {
				name: `${owner.text}.${name.text}`,
				kind: "method",
				line: name.startPosition.row + 1,
			};
		});
	}

	private importsOf(root: Node): string[] {
		const specifiers = this.queries.imports.flatMap((query) =>
			query
				.matches(root)
				.flatMap((match) => match.captures)
				.filter((capture) => capture.name === "specifier")
				.map((capture) => capture.node.text),
		);
		return [...new Set(specifiers)];
	}
}
