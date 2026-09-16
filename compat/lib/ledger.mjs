/** Load the TSV ledger, surface list, mechanism table, and the upstream pin. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseTsv } from "./tsv.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function contractFiles(contractsDir) {
  if (!existsSync(contractsDir)) return [];
  return readdirSync(contractsDir)
    .filter((name) => name.endsWith(".tsv"))
    .toSorted()
    .map((name) => join(contractsDir, name));
}

export function loadLedger(repoRoot) {
  const specDir = join(repoRoot, "spec");
  const files = contractFiles(join(specDir, "contracts"));
  const rows = files.flatMap((file) => parseTsv(readFileSync(file, "utf8")));
  const surfaces = parseTsv(readFileSync(join(specDir, "surfaces.tsv"), "utf8"));
  const mechanisms = parseTsv(readFileSync(join(specDir, "mechanisms.tsv"), "utf8"));
  const lock = readJson(join(repoRoot, "upstream.lock.json"));
  return { rows, surfaces, mechanisms, lock, contractFiles: files };
}
