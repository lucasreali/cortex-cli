import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test run gets a throwaway project registry. Spawned CLIs and MCP
// servers inherit process.env, so without this the suite would write the
// developer's real ~/.cortex/projects.json.
process.env.CORTEX_PROJECTS_FILE ??= join(
	mkdtempSync(join(tmpdir(), "cortex-test-registry-")),
	"projects.json",
);
