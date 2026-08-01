import { compile, DEFAULT_OUTFILE } from "./compile";

const outfile = process.env.CORTEX_OUTFILE ?? DEFAULT_OUTFILE;
const target = process.env.CORTEX_TARGET as Bun.Build.CompileTarget | undefined;

try {
	await compile({ outfile, target });
} catch (error) {
	console.error(String(error));
	process.exit(1);
}

const size = Bun.file(outfile).size;
console.log(`${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
