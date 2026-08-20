import { Language, type Node, Parser, Query, type Tree } from "web-tree-sitter";
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with {
	type: "file",
};
import type { CodeSymbol } from "@/domain";
import { QUALIFIED_SEPARATOR } from "@/support/symbol-key";
import type { GrammarPaths } from "./grammar";

export interface ExtractedSource {
	symbols: CodeSymbol[];
	imports: string[];
	// A file the grammar could not read end to end contributes only the symbols
	// before the break, so "this symbol is absent" stops being a claim anyone
	// may act on. Recorded per file rather than thrown: one unparsable file is
	// still a file, and the imports before the break are still true.
	hasError: boolean;
}

// One query per concern, never one per pattern: `matches` walks the whole tree,
// so a query per declaration kind would parse once and then traverse twenty
// times. The capture name carries the kind instead.
const IMPORT_QUERY = [
	"(import_statement source: (string (string_fragment) @specifier))",
	"(export_statement source: (string (string_fragment) @specifier))",
	"(import_statement (import_require_clause source: (string (string_fragment) @specifier)))",
	`(call_expression
		function: (import)
		arguments: (arguments (string (string_fragment) @specifier)))`,
	`(call_expression
		function: (identifier) @callee
		arguments: (arguments (string (string_fragment) @specifier))
		(#eq? @callee "require"))`,
].join("\n");

const DECLARATION_QUERY = [
	"(function_declaration name: (identifier) @function)",
	"(generator_function_declaration name: (identifier) @function)",
	"(function_signature name: (identifier) @function)",
	"(class_declaration name: (type_identifier) @class)",
	"(abstract_class_declaration name: (type_identifier) @class)",
	"(interface_declaration name: (type_identifier) @interface)",
	"(type_alias_declaration name: (type_identifier) @type)",
	"(enum_declaration name: (identifier) @enum)",
	"(internal_module name: (identifier) @namespace)",
	"(variable_declarator name: (identifier) @arrow value: (arrow_function))",
	"(variable_declarator name: (identifier) @function value: (function_expression))",
	`(export_statement
		declaration: (lexical_declaration
			(variable_declarator name: (identifier) @variable)))`,
	`(export_statement
		declaration: (variable_declaration
			(variable_declarator name: (identifier) @variable)))`,
].join("\n");

// What an exported binding is called when nothing more specific claimed it:
// `export const Card = React.memo(...)` is a variable, `export const f = () =>
// {}` is an arrow, and both match the exported-binding pattern.
const FALLBACK_KIND = "variable";

const CLASS_MEMBERS = `[
	(method_definition)
	(abstract_method_signature)
	(public_field_definition)
]`;

const MEMBER_QUERY = [
	`(class_declaration
		name: (type_identifier) @owner
		body: (class_body ${CLASS_MEMBERS} @member))`,
	`(abstract_class_declaration
		name: (type_identifier) @owner
		body: (class_body ${CLASS_MEMBERS} @member))`,
].join("\n");

const MEMBER_NAME_TYPES = new Set([
	"property_identifier",
	"private_property_identifier",
]);

export class TsxExtractor {
	// Named for the file it has always lived in: decisions already in
	// `.cortex/decisions/` anchor symbols here, and an anchor is immutable.
	static async create(grammars: GrammarPaths): Promise<TsxExtractor> {
		// The default lookup resolves web-tree-sitter.wasm next to the library's
		// JS, which no longer exists once bundled into a compiled binary; the
		// embedded copy works in both worlds.
		await Parser.init({ locateFile: () => runtimeWasm });
		const [typescript, tsx] = await Promise.all([
			Language.load(grammars.ts),
			Language.load(grammars.tsx),
		]);
		return new TsxExtractor(
			new LanguagePipeline(typescript),
			new LanguagePipeline(tsx),
		);
	}

	private constructor(
		private readonly typescript: LanguagePipeline,
		private readonly tsx: LanguagePipeline,
	) {}

	// `.ts` is the only extension where `<T>expr` means a type assertion; `.js`
	// and `.jsx` carry JSX far too often to hand them the other grammar.
	extract(sourceText: string, lang: string): ExtractedSource {
		const pipeline = lang === "ts" ? this.typescript : this.tsx;
		return pipeline.extract(sourceText);
	}
}

class LanguagePipeline {
	private readonly parser: Parser;
	private readonly queries: {
		imports: Query;
		declarations: Query;
		members: Query;
	};

	constructor(language: Language) {
		this.parser = new Parser();
		this.parser.setLanguage(language);
		this.queries = {
			imports: new Query(language, IMPORT_QUERY),
			declarations: new Query(language, DECLARATION_QUERY),
			members: new Query(language, MEMBER_QUERY),
		};
	}

	// web-tree-sitter frees a tree only through delete(); it registers no
	// FinalizationRegistry, so a tree left to the GC keeps its emscripten
	// allocation — around 30x the parsed bytes — for the life of the process.
	// Both halves materialize plain objects, so nothing outlives the tree.
	extract(sourceText: string): ExtractedSource {
		// parse() only returns null without a language set or on cancellation;
		// neither happens here, so the cast encodes that invariant.
		const tree = this.parser.parse(sourceText) as Tree;
		try {
			return {
				symbols: this.symbolsOf(tree.rootNode),
				imports: this.importsOf(tree.rootNode),
				hasError: tree.rootNode.hasError,
			};
		} finally {
			tree.delete();
		}
	}

	// A getter and its setter share a name and a line, so the kind is the only
	// thing that tells the two rows apart — which is why one row per (line,
	// kind, name) is the rule rather than one row per place.
	private symbolsOf(root: Node): CodeSymbol[] {
		const symbols = distinct(
			preferSpecific([...this.declarationsOf(root), ...this.membersOf(root)]),
		);
		return symbols.sort(
			(a, b) => a.line - b.line || a.name.localeCompare(b.name),
		);
	}

	private declarationsOf(root: Node): CodeSymbol[] {
		return this.queries.declarations
			.matches(root)
			.flatMap((match) => match.captures)
			.map((capture) => symbolAt(capture.node, capture.name));
	}

	private membersOf(root: Node): CodeSymbol[] {
		return this.queries.members
			.matches(root)
			.flatMap((match) => memberSymbolOf(match));
	}

	private importsOf(root: Node): string[] {
		const specifiers = this.queries.imports
			.matches(root)
			.flatMap((match) => match.captures)
			.filter((capture) => capture.name === "specifier")
			.map((capture) => capture.node.text);
		return [...new Set(specifiers)];
	}
}

interface QueryMatch {
	captures: Array<{ name: string; node: Node }>;
}

function capturesOf(match: QueryMatch): Map<string, Node> {
	return new Map(match.captures.map((capture) => [capture.name, capture.node]));
}

function memberSymbolOf(match: QueryMatch): CodeSymbol[] {
	const named = capturesOf(match);
	const owner = named.get("owner");
	const member = named.get("member");
	if (!owner || !member) return [];
	const name = member.childForFieldName("name");
	if (!name || !MEMBER_NAME_TYPES.has(name.type)) return [];
	return [
		{
			name: `${owner.text}${QUALIFIED_SEPARATOR}${name.text}`,
			kind: kindOfMember(member),
			line: name.startPosition.row + 1,
		},
	];
}

function symbolAt(node: Node, kind: string): CodeSymbol {
	return { name: node.text, kind, line: node.startPosition.row + 1 };
}

function kindOfMember(member: Node): string {
	if (member.type === "public_field_definition") return "field";
	if (member.type === "abstract_method_signature") return "method";
	return accessorKindOf(member) ?? "method";
}

function accessorKindOf(member: Node): string | null {
	const keyword = member.children.find(
		(child) => child?.type === "get" || child?.type === "set",
	);
	if (!keyword) return null;
	return keyword.type === "get" ? "getter" : "setter";
}

function preferSpecific(symbols: CodeSymbol[]): CodeSymbol[] {
	const claimed = new Set(
		symbols.filter((symbol) => symbol.kind !== FALLBACK_KIND).map(placeOf),
	);
	return symbols.filter(
		(symbol) => symbol.kind !== FALLBACK_KIND || !claimed.has(placeOf(symbol)),
	);
}

function placeOf(symbol: CodeSymbol): string {
	return `${symbol.line} ${symbol.name}`;
}

function distinct(symbols: CodeSymbol[]): CodeSymbol[] {
	const seen = new Set<string>();
	return symbols.filter((symbol) => {
		const key = `${symbol.kind} ${placeOf(symbol)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
