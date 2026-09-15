import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYERS, layerFiles, resolveLayers } from "./registry.mjs";
import { ensurePeerLinks } from "./support/link-peers.mjs";

const LAYER_TIMEOUT_MS = 180000;

const USAGE =
  "Usage: node tests/runner.mjs [--layer N|legacy|all] [--list] [--dry-run] [--verbose] [--bail] [file...]";

function commandExists(cmd) {
  const path = process.env.PATH || "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

function failingFiles(output) {
  const files = new Set();
  for (const match of output.matchAll(/^test at (.+?):\d+:\d+$/gm)) {
    files.add(match[1]);
  }
  return [...files];
}

const args = process.argv.slice(2);
const flags = {
  layer: null,
  list: false,
  dryRun: false,
  verbose: false,
  bail: false,
  files: [],
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--layer" && args[i + 1]) {
    flags.layer = args[++i];
  } else if (arg === "--list") {
    flags.list = true;
  } else if (arg === "--dry-run") {
    flags.dryRun = true;
  } else if (arg === "--verbose") {
    flags.verbose = true;
  } else if (arg === "--bail") {
    flags.bail = true;
  } else if (!arg.startsWith("-")) {
    flags.files.push(arg);
  } else {
    console.error(`Unknown option: ${arg}`);
    console.error(USAGE);
    process.exit(2);
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const positionalFiles = flags.files.map((file) =>
  isAbsolute(file) ? file : resolve(process.cwd(), file),
);

if (flags.list) {
  console.log("Available layers:");
  for (const layer of LAYERS) {
    const files = layerFiles(layer, repoRoot);
    const optInNote = layer.optIn ? " (opt-in)" : "";
    const requiresNote = layer.requires?.length ? ` [requires: ${layer.requires.join(", ")}]` : "";
    console.log(`  ${layer.id}. ${layer.name}${optInNote}${requiresNote} (${layer.runner})`);
    if (layer.runner === "commands") {
      for (const [cmd, cmdArgs, cwd] of layer.commands) {
        console.log(`    ${cmd} ${cmdArgs.join(" ")} (cwd: ${join(repoRoot, cwd)})`);
      }
    } else if (files.length === 0) {
      console.log(`    (no test files in ${layer.dir})`);
    } else {
      for (const file of files) {
        console.log(`    ${file}`);
      }
    }
  }
  process.exit(0);
}

console.log("Bootstrapping peer symlinks...");
try {
  const result = ensurePeerLinks(repoRoot);
  if (result.created.length > 0) {
    console.log(`Created ${result.created.length} symlinks`);
  }
  if (result.repaired.length > 0) {
    console.log(`Repaired ${result.repaired.length} symlinks`);
  }
  console.log("Peer symlinks ready");
} catch (err) {
  console.error("Peer bootstrap failed:", err.message);
  process.exit(4);
}

const results = [];
let anyFailed = false;

function record(entry) {
  results.push(entry);
}

function runNodeTest(label, files, timeoutMs = LAYER_TIMEOUT_MS) {
  console.log(`\nRunning ${label}...`);
  const result = spawnSync("node", ["--test", "--test-reporter=spec", ...files], {
    cwd: repoRoot,
    stdio: flags.verbose ? "inherit" : "pipe",
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!flags.verbose) {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  }

  if (result.error && result.error.code === "ETIMEDOUT") {
    console.error(`Layer ${label} timed out after ${timeoutMs}ms`);
    record({ layer: label, status: "fail", reason: `timeout after ${timeoutMs}ms` });
    return true;
  }

  if (result.status === 0) {
    record({ layer: label, status: "pass", files: files.length });
    return false;
  }

  record({
    layer: label,
    status: "fail",
    files: files.length,
    code: result.status,
    failing: failingFiles(stdout),
  });
  return true;
}

function runCommands(label, commands, timeoutMs = LAYER_TIMEOUT_MS) {
  let failed = false;
  for (const [cmd, cmdArgs, cwd] of commands) {
    const cmdLabel = `${label}: ${cmd} ${cmdArgs.join(" ")}`;

    if (flags.dryRun) {
      console.log(`WOULD RUN ${cmdLabel} (cwd: ${join(repoRoot, cwd)})`);
      continue;
    }

    console.log(`\nRunning ${cmdLabel}...`);
    const result = spawnSync(cmd, cmdArgs, {
      cwd: join(repoRoot, cwd),
      stdio: flags.verbose ? "inherit" : "pipe",
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (!flags.verbose) {
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
    }

    if (result.error && result.error.code === "ETIMEDOUT") {
      console.error(`${cmdLabel} timed out after ${timeoutMs}ms`);
      record({ layer: cmdLabel, status: "fail", reason: `timeout after ${timeoutMs}ms` });
      failed = true;
      if (flags.bail) return true;
      continue;
    }

    if (result.status === 0) {
      record({ layer: cmdLabel, status: "pass" });
    } else {
      record({ layer: cmdLabel, status: "fail", code: result.status });
      failed = true;
      if (flags.bail) return true;
    }
  }
  return failed;
}

if (flags.files.length > 0) {
  if (flags.dryRun) {
    console.log("WOULD RUN positional files:");
    for (const file of positionalFiles) console.log(`  ${file}`);
  } else {
    anyFailed = runNodeTest("positional files", positionalFiles);
  }
} else {
  let selectedLayers;
  try {
    selectedLayers = flags.layer ? resolveLayers(flags.layer) : LAYERS;
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  for (const layer of selectedLayers) {
    const layerLabel =
      typeof layer.id === "number" ? `Layer ${layer.id} (${layer.name})` : layer.name;

    if (!flags.layer && layer.optIn) {
      console.log(`SKIP ${layerLabel}: opt-in layer (run with --layer ${layer.id})`);
      record({ layer: layerLabel, status: "skip", reason: "opt-in" });
      continue;
    }

    if (layer.requires?.length) {
      const missing = layer.requires.find((tool) => !commandExists(tool));
      if (missing) {
        console.error(`MISSING TOOL ${missing} (required by layer ${layer.id})`);
        process.exit(3);
      }
    }

    if (layer.runner === "node-test") {
      const files = layerFiles(layer, repoRoot);

      if (files.length === 0) {
        console.log(`SKIP ${layerLabel}: no test files in ${layer.dir}`);
        record({ layer: layerLabel, status: "skip", reason: "no test files" });
        continue;
      }

      if (flags.dryRun) {
        console.log(`WOULD RUN ${layerLabel}:`);
        for (const file of files) console.log(`  ${file}`);
        continue;
      }

      if (runNodeTest(layerLabel, files, layer.timeoutMs)) {
        anyFailed = true;
        if (flags.bail) break;
      }
    } else if (layer.runner === "commands") {
      if (flags.dryRun) {
        runCommands(layerLabel, layer.commands);
        continue;
      }
      if (runCommands(layerLabel, layer.commands, layer.timeoutMs)) {
        anyFailed = true;
        if (flags.bail) break;
      }
    }
  }
}

if (!flags.dryRun) {
  console.log("\n=== Test Summary ===");
  for (const result of results) {
    const status = result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "⊘";
    const detail = result.files
      ? ` (${result.files} files)`
      : result.reason
        ? ` (${result.reason})`
        : "";
    console.log(`${status} ${result.layer}${detail}`);
  }

  const failing = results.filter((r) => r.status === "fail");
  const failingFilesList = [...new Set(failing.flatMap((r) => r.failing ?? []))];
  if (failingFilesList.length > 0) {
    console.log("\nFailing files:");
    for (const file of failingFilesList) {
      console.log(`  ${file}`);
    }
  }
}

process.exit(anyFailed ? 1 : 0);
