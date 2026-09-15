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
    } catch {
      continue;
    }
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

function parseArgs(args) {
  const flags = {
    layer: null,
    list: false,
    dryRun: false,
    verbose: false,
    bail: false,
    files: [],
  };

  for (let i = 0; i < args.length; i = i + 1) {
    const arg = args[i];
    if (arg === "--layer" && args[i + 1]) {
      i = i + 1;
      flags.layer = args[i];
    } else if (arg === "--list") {
      flags.list = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--verbose") {
      flags.verbose = true;
    } else if (arg === "--bail") {
      flags.bail = true;
    } else if (!arg.startsWith("-")) {
      flags.files = [...flags.files, arg];
    } else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.stderr.write(`${USAGE}\n`);
      process.exit(2);
    }
  }
  return flags;
}

const flags = parseArgs(args);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const positionalFiles = flags.files.map((file) =>
  isAbsolute(file) ? file : resolve(process.cwd(), file),
);

if (flags.list) {
  process.stdout.write("Available layers:\n");
  for (const layer of LAYERS) {
    const files = layerFiles(layer, repoRoot);
    const optInNote = layer.optIn ? " (opt-in)" : "";
    const requiresNote = layer.requires?.length ? ` [requires: ${layer.requires.join(", ")}]` : "";
    process.stdout.write(`  ${layer.id}. ${layer.name}${optInNote}${requiresNote} (${layer.runner})\n`);
    if (layer.runner === "commands") {
      for (const [cmd, cmdArgs, cwd] of layer.commands) {
        process.stdout.write(`    ${cmd} ${cmdArgs.join(" ")} (cwd: ${join(repoRoot, cwd)})\n`);
      }
    } else if (files.length === 0) {
      process.stdout.write(`    (no test files in ${layer.dir})\n`);
    } else {
      for (const file of files) {
        process.stdout.write(`    ${file}\n`);
      }
    }
  }
  process.exit(0);
}

process.stdout.write("Bootstrapping peer symlinks...\n");
try {
  const result = ensurePeerLinks(repoRoot);
  if (result.created.length > 0) {
    process.stdout.write(`Created ${result.created.length} symlinks\n`);
  }
  if (result.repaired.length > 0) {
    process.stdout.write(`Repaired ${result.repaired.length} symlinks\n`);
  }
  process.stdout.write("Peer symlinks ready\n");
} catch (err) {
  process.stderr.write(`Peer bootstrap failed: ${err.message}\n`);
  process.exit(4);
}

let results = [];
let anyFailed = false;

function record(entry) {
  results = [...results, entry];
}

function runNodeTest(label, files, timeoutMs = LAYER_TIMEOUT_MS) {
  process.stdout.write(`\nRunning ${label}...\n`);
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
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }

  if (result.error && result.error.code === "ETIMEDOUT") {
    process.stderr.write(`Layer ${label} timed out after ${timeoutMs}ms\n`);
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
      process.stdout.write(`WOULD RUN ${cmdLabel} (cwd: ${join(repoRoot, cwd)})\n`);
      continue;
    }

    process.stdout.write(`\nRunning ${cmdLabel}...\n`);
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
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }

    if (result.error && result.error.code === "ETIMEDOUT") {
      process.stderr.write(`${cmdLabel} timed out after ${timeoutMs}ms\n`);
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
    process.stdout.write("WOULD RUN positional files:\n");
    for (const file of positionalFiles) process.stdout.write(`  ${file}\n`);
  } else {
    anyFailed = runNodeTest("positional files", positionalFiles);
  }
} else {
  let selectedLayers;
  try {
    selectedLayers = flags.layer ? resolveLayers(flags.layer) : LAYERS;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  for (const layer of selectedLayers) {
    const layerLabel =
      typeof layer.id === "number" ? `Layer ${layer.id} (${layer.name})` : layer.name;

    if (!flags.layer && layer.optIn) {
      process.stdout.write(`SKIP ${layerLabel}: opt-in layer (run with --layer ${layer.id})\n`);
      record({ layer: layerLabel, status: "skip", reason: "opt-in" });
      continue;
    }

    if (layer.requires?.length) {
      const missing = layer.requires.find((tool) => !commandExists(tool));
      if (missing) {
        process.stderr.write(`MISSING TOOL ${missing} (required by layer ${layer.id})\n`);
        process.exit(3);
      }
    }

    if (layer.runner === "node-test") {
      const files = layerFiles(layer, repoRoot);

      if (files.length === 0) {
        process.stdout.write(`SKIP ${layerLabel}: no test files in ${layer.dir}\n`);
        record({ layer: layerLabel, status: "skip", reason: "no test files" });
        continue;
      }

      if (flags.dryRun) {
        process.stdout.write(`WOULD RUN ${layerLabel}:\n`);
        for (const file of files) process.stdout.write(`  ${file}\n`);
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
  process.stdout.write("\n=== Test Summary ===\n");
  for (const result of results) {
    const status = result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "⊘";
    const detail = result.files
      ? ` (${result.files} files)`
      : result.reason
        ? ` (${result.reason})`
        : "";
    process.stdout.write(`${status} ${result.layer}${detail}\n`);
  }

  const failing = results.filter((r) => r.status === "fail");
  const failingFilesList = [...new Set(failing.flatMap((r) => r.failing ?? []))];
  if (failingFilesList.length > 0) {
    process.stdout.write("\nFailing files:\n");
    for (const file of failingFilesList) {
      process.stdout.write(`  ${file}\n`);
    }
  }
}

process.exit(anyFailed ? 1 : 0);
