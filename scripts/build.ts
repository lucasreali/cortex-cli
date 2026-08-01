import { compile, DEFAULT_OUTFILE, sizeInMegabytes } from "./compile";

const outfile = process.env.CORTEX_OUTFILE ?? DEFAULT_OUTFILE;
const target = process.env.CORTEX_TARGET as Bun.Build.CompileTarget | undefined;

try {
	await compile({ outfile, target });
} catch (error) {
	console.error(String(error));
	process.exit(1);
}

console.log(`${outfile} (${sizeInMegabytes(outfile)} MB)`);
