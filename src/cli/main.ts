#!/usr/bin/env bun
import { runIndex } from "./commands/code-index";
import { runDoctor } from "./commands/doctor";
import { runEmbed } from "./commands/embed";
import { runImpact } from "./commands/impact";
import { runInit } from "./commands/init";
import { runLog } from "./commands/log";
import { runSearch } from "./commands/search";
import { runServe } from "./commands/serve";
import { runWhy } from "./commands/why";
import { failure, style } from "./style";

interface Command {
	run(args: string[], cwd: string): Promise<number | null>;
	usage: string;
	description: string;
}

const COMMANDS: Record<string, Command> = {
	init: {
		run: runInit,
		usage: "init [--yes]",
		description: "create .cortex/ and register the project",
	},
	serve: {
		run: runServe,
		usage: "serve --mcp",
		description: "start the MCP server (stdio)",
	},
	log: {
		run: runLog,
		usage: "log [--module M] [--since SHA]",
		description: "list active decisions",
	},
	why: {
		run: runWhy,
		usage: "why <path|symbol>",
		description: "show decisions anchored to a path or symbol",
	},
	search: {
		run: runSearch,
		usage: "search <terms...> [--exact]",
		description: "search decisions by meaning or keyword",
	},
	impact: {
		run: runImpact,
		usage: "impact <id> [--depth N]",
		description: "trace decisions and code affected by a decision",
	},
	index: {
		run: runIndex,
		usage: "index [--force]",
		description: "build or refresh the code index",
	},
	embed: {
		run: runEmbed,
		usage: "embed --missing | --rebuild [--yes]",
		description: "generate embeddings for semantic search",
	},
	doctor: {
		run: runDoctor,
		usage: "doctor",
		description: "check store and index health",
	},
};

const USAGE_COLUMN = Math.max(
	...Object.values(COMMANDS).map((command) => command.usage.length),
);

function printUsage(): void {
	console.log(
		`${style.bold("cortex")} ${style.dim("— persistent decision memory for coding agents")}`,
	);
	console.log("\nusage: cortex <command>\n\ncommands:");
	for (const command of Object.values(COMMANDS)) {
		const usage = style.cyan(command.usage.padEnd(USAGE_COLUMN));
		console.log(`  ${usage}  ${command.description}`);
	}
}

async function main(): Promise<void> {
	const [name, ...args] = process.argv.slice(2);
	const command = name ? COMMANDS[name] : undefined;
	if (!command) {
		if (name) console.error(failure(`unknown command: ${name}`));
		printUsage();
		process.exit(name ? 1 : 0);
	}
	try {
		const code = await command.run(args, process.cwd());
		if (code !== null) process.exit(code);
	} catch (error) {
		console.error(
			failure(error instanceof Error ? error.message : String(error)),
		);
		process.exit(1);
	}
}

await main();
