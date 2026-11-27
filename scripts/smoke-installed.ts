import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const packageName = process.argv[2];
assert.ok(packageName, "Expected the installed package name");

const cwd = process.cwd();
const loader = new DefaultResourceLoader({
	cwd,
	agentDir: resolve(cwd, ".pi-agent"),
	settingsManager: SettingsManager.inMemory(),
	additionalExtensionPaths: [resolve(cwd, "node_modules", packageName)],
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});

await loader.reload();
const result = loader.getExtensions();
assert.equal(result.errors.length, 0, "Packed extension must load without errors");
assert.equal(result.extensions.length, 1, "Expected exactly one packed extension entry");
process.stdout.write("Packed extension loaded through Pi.\n");
