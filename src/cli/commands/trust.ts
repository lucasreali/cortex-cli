import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { reportFailure } from "@/cli/error-output";
import { style, success } from "@/cli/style";
import { ProjectRoot } from "@/storage/project-root";
import { revokeProject, trustProject } from "@/storage/project-trust";

export async function runTrust(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { revoke: { type: "boolean", default: false } },
	});
	const project = ProjectRoot.nearest(resolve(cwd));
	if (!project) {
		reportFailure("no Cortex project here — run cortex init first");
		return 1;
	}
	const root = style.cyan(project.directory);
	if (values.revoke) {
		revokeProject(project.directory);
		console.log(
			success(`The prompt hook no longer reads decisions from ${root}`),
		);
		return 0;
	}
	trustProject(project.directory);
	console.log(success(`The prompt hook now reads decisions from ${root}`));
	console.log(
		style.dim(
			"Decision files arrive through pull requests; cortex doctor flags " +
				"links, commands and catch-all keywords in them.",
		),
	);
	return 0;
}
