import { join } from "node:path";
import { parseJsonOrNull } from "@/support/json";

export interface CortexConfig {
	model_id: string;
	schema_version: number;
}

export type ConfigRead =
	| { state: "ok"; config: CortexConfig }
	| { state: "missing" }
	| { state: "unreadable" };

// A corrupt config is not a missing one: doctor told the user to run
// `cortex init` for a file that already exists and would not be overwritten.
export async function readConfigState(cortexDir: string): Promise<ConfigRead> {
	const file = Bun.file(configPath(cortexDir));
	if (!(await file.exists())) return { state: "missing" };
	const config = parseJsonOrNull<CortexConfig>(await file.text());
	if (!config) return { state: "unreadable" };
	return { state: "ok", config };
}

export async function readConfig(
	cortexDir: string,
): Promise<CortexConfig | null> {
	const read = await readConfigState(cortexDir);
	return read.state === "ok" ? read.config : null;
}

export async function writeConfig(
	cortexDir: string,
	config: CortexConfig,
): Promise<void> {
	await Bun.write(
		configPath(cortexDir),
		`${JSON.stringify(config, null, "\t")}\n`,
	);
}

function configPath(cortexDir: string): string {
	return join(cortexDir, "config");
}
