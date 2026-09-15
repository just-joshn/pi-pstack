import { existsSync, symlinkSync, lstatSync, readlinkSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execSync } from "node:child_process";

export function findHostPi() {
  let tried = [];
  
  if (process.env.PI_INSTALL_DIR) {
    const packageRoot = resolve(process.env.PI_INSTALL_DIR);
    tried = [...tried, `PI_INSTALL_DIR=${packageRoot}`];
    if (existsSync(join(packageRoot, "package.json"))) {
      return buildPackageMap(packageRoot);
    }
  }

  const nodeModulesGuess = join(dirname(dirname(process.execPath)), "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  tried = [...tried, nodeModulesGuess];
  if (existsSync(join(nodeModulesGuess, "package.json"))) {
    return buildPackageMap(nodeModulesGuess);
  }

  let globalRoot;
  try {
    globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    const globalGuess = join(globalRoot, "@earendil-works", "pi-coding-agent");
    tried = [...tried, globalGuess];
    if (existsSync(join(globalGuess, "package.json"))) {
      return buildPackageMap(globalGuess);
    }
  } catch (err) {
    tried = [...tried, `npm root -g failed: ${err.message}`];
  }

  throw new Error(`Could not find pi-coding-agent installation. Set PI_INSTALL_DIR. Tried:\n${tried.join("\n")}`);
}

function buildPackageMap(packageRoot) {
  const nodeModules = join(packageRoot, "node_modules");
  const packages = {
    "pi-coding-agent": packageRoot,
    "pi-ai": join(nodeModules, "@earendil-works", "pi-ai"),
    "pi-agent-core": join(nodeModules, "@earendil-works", "pi-agent-core"),
    "pi-tui": join(nodeModules, "@earendil-works", "pi-tui"),
    typebox: join(nodeModules, "typebox"),
  };

  for (const [name, path] of Object.entries(packages)) {
    if (!existsSync(join(path, "package.json"))) {
      throw new Error(`Missing peer package ${name} at ${path}`);
    }
  }

  return { packageRoot, packages };
}

export function ensurePeerLinks(repoRoot) {
  const { packages } = findHostPi();
  const repoNodeModules = join(repoRoot, "node_modules");
  mkdirSync(repoNodeModules, { recursive: true });
  mkdirSync(join(repoNodeModules, "@earendil-works"), { recursive: true });

  let created = [];
  let repaired = [];

  const links = [
    [join(repoNodeModules, "typebox"), packages.typebox],
    [join(repoNodeModules, "@earendil-works", "pi-coding-agent"), packages["pi-coding-agent"]],
    [join(repoNodeModules, "@earendil-works", "pi-ai"), packages["pi-ai"]],
    [join(repoNodeModules, "@earendil-works", "pi-agent-core"), packages["pi-agent-core"]],
    [join(repoNodeModules, "@earendil-works", "pi-tui"), packages["pi-tui"]],
  ];

  for (const [link, target] of links) {
    const stat = lstatSync(link, { throwIfNoEntry: false });

    if (!stat) {
      symlinkSync(target, link);
      created = [...created, link];
      continue;
    }

    if (stat.isSymbolicLink()) {
      const current = readlinkSync(link);
      const resolved = resolve(dirname(link), current);
      if (resolved !== target || !existsSync(resolved)) {
        unlinkSync(link);
        symlinkSync(target, link);
        repaired = [...repaired, link];
      }
      continue;
    }

    throw new Error(
      `Refusing to replace non-symlink ${link}. Remove it or set PI_INSTALL_DIR and re-run tests/support/link-peers.mjs.`,
    );
  }

  return { created, repaired };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = findHostPi();
    process.stdout.write("Pi installation found:\n");
    process.stdout.write(`  packageRoot: ${result.packageRoot}\n`);
    for (const [name, path] of Object.entries(result.packages)) {
      process.stdout.write(`  ${name}: ${path}\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
