import { join } from "node:path";

export interface CortexConfig {
	model_id: string;
	schema_version: number;
}

export async function readConfig(
	cortexDir: string,
): Promise<CortexConfig | null> {
	const file = Bun.file(configPath(cortexDir));
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as CortexConfig;
	} catch {
		return null;
	}
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
