#!/usr/bin/env bun
import { errorMessage } from "@/support/errors";
import { CORTEX_VERSION } from "@/version";
import { runIndex } from "./commands/code-index";
import { runDoctor } from "./commands/doctor";
import { runEmbed } from "./commands/embed";
import { runEmbedDaemonCommand } from "./commands/embed-daemon";
import { runEmbedWorkerCommand } from "./commands/embed-worker";
import { runImpact } from "./commands/impact";
import { runInit } from "./commands/init";
import { runLog } from "./commands/log";
import { runPromptHook } from "./commands/prompt-hook";
import { runSearch } from "./commands/search";
import { runServe } from "./commands/serve";
import { runUpgrade } from "./commands/upgrade";
import { runWhy } from "./commands/why";
import { failure, style } from "./style";

interface Command {
	run(args: string[], cwd: string): Promise<number | null>;
	usage: string;
	description: string;
	hidden?: boolean;
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
		usage: "log [--module M] [--since SHA] [--json]",
		description: "list active decisions",
	},
	why: {
		run: runWhy,
		usage: "why <path|symbol> [--json]",
		description: "show decisions anchored to a path or symbol",
	},
	search: {
		run: runSearch,
		usage: "search <terms...> [--exact] [--json]",
		description: "search decisions by meaning or keyword",
	},
	impact: {
		run: runImpact,
		usage: "impact <id> [--depth N] [--json]",
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
		usage: "doctor [--json]",
		description: "check store and index health",
	},
	upgrade: {
		run: runUpgrade,
		usage: "upgrade [--check] [--version V]",
		description: "install the latest cortex release",
	},
	"prompt-hook": {
		run: runPromptHook,
		usage: "prompt-hook",
		description: "Claude Code UserPromptSubmit hook (JSON on stdin)",
		hidden: true,
	},
	"embed-worker": {
		run: runEmbedWorkerCommand,
		usage: "embed-worker",
		description: "embedding worker subprocess (NDJSON on stdio)",
		hidden: true,
	},
	"embed-daemon": {
		run: runEmbedDaemonCommand,
		usage: "embed-daemon [model]",
		description: "shared embedding daemon (Unix socket)",
		hidden: true,
	},
};

const VISIBLE_COMMANDS = Object.values(COMMANDS).filter(
	(command) => !command.hidden,
);

const USAGE_COLUMN = Math.max(
	...VISIBLE_COMMANDS.map((command) => command.usage.length),
);

const GLOBAL_FLAGS = [
	{ usage: "-v, --version", description: "print the version" },
	{ usage: "-h, --help", description: "show this help" },
];

function printUsage(): void {
	console.log(
		`${style.bold("cortex")} ${style.dim(`v${CORTEX_VERSION} — persistent decision memory for coding agents`)}`,
	);
	console.log("\nusage: cortex <command>\n\ncommands:");
	for (const command of VISIBLE_COMMANDS) {
		const usage = style.cyan(command.usage.padEnd(USAGE_COLUMN));
		console.log(`  ${usage}  ${command.description}`);
	}
	console.log("\nflags:");
	for (const flag of GLOBAL_FLAGS) {
		const usage = style.cyan(flag.usage.padEnd(USAGE_COLUMN));
		console.log(`  ${usage}  ${flag.description}`);
	}
}

async function main(): Promise<void> {
	const [name, ...args] = process.argv.slice(2);
	if (name === "--version" || name === "-v") {
		console.log(CORTEX_VERSION);
		return;
	}
	if (name === "--help" || name === "-h") {
		printUsage();
		return;
	}
	const command = name ? COMMANDS[name] : undefined;
	if (!command) {
		if (name) console.error(failure(`unknown command: ${name}`));
		printUsage();
		process.exit(name ? 1 : 0);
	}
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`usage: cortex ${command.usage}\n\n${command.description}`);
		return;
	}
	try {
		const code = await command.run(args, process.cwd());
		if (code !== null) process.exit(code);
	} catch (error) {
		console.error(failure(errorMessage(error)));
		process.exit(1);
	}
}

await main();
