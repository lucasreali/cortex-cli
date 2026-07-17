#!/usr/bin/env bun
import { runDoctor } from "./commands/doctor";
import { runEmbed } from "./commands/embed";
import { runImpact } from "./commands/impact";
import { runInit } from "./commands/init";
import { runLog } from "./commands/log";
import { runSearch } from "./commands/search";
import { runServe } from "./commands/serve";
import { runWhy } from "./commands/why";

interface Command {
	run(args: string[], cwd: string): Promise<number | null>;
	usage: string;
}

const COMMANDS: Record<string, Command> = {
	init: { run: runInit, usage: "init [--yes]" },
	serve: { run: runServe, usage: "serve --mcp" },
	log: { run: runLog, usage: "log [--module M] [--since SHA]" },
	why: { run: runWhy, usage: "why <path>" },
	search: { run: runSearch, usage: "search <terms...> [--exact]" },
	impact: { run: runImpact, usage: "impact <id> [--depth N]" },
	embed: { run: runEmbed, usage: "embed --missing | --rebuild [--yes]" },
	doctor: { run: runDoctor, usage: "doctor" },
};

function printUsage(): void {
	console.log("usage: cortex <command>\n\ncommands:");
	for (const command of Object.values(COMMANDS)) {
		console.log(`  cortex ${command.usage}`);
	}
}

async function main(): Promise<void> {
	const [name, ...args] = process.argv.slice(2);
	const command = name ? COMMANDS[name] : undefined;
	if (!command) {
		printUsage();
		process.exit(name ? 1 : 0);
	}
	try {
		const code = await command.run(args, process.cwd());
		if (code !== null) process.exit(code);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

await main();
