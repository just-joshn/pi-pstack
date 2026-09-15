#!/usr/bin/env node
/**
 * Structural checker for the rebuild contract. It parses spec/contracts/*.tsv,
 * validates row form and verification references, checks tool, surface, and
 * mechanism completeness, and prints coverage. It never executes a proof.
 *
 * Usage:
 *   node spec/spec-check.mjs                  integrity check plus coverage
 *   node spec/spec-check.mjs --list           rows grouped by surface
 *   node spec/spec-check.mjs --summary        coverage block only
 *   node spec/spec-check.mjs --require-complete
 *                                             also require U == 0, D == 0,
 *                                             and a VERIFIED twin per ceiling
 *
 * Exit codes: 0 pass, 1 integrity or completion failure, 2 usage error.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function out(line) {
  process.stdout.write(String(line) + "\n");
}

function repoRoot() {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const start = resolve(selfDir, "..");
  function ascend(dir) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) return dir;
    const parent = resolve(dir, "..");
    return parent === dir ? dir : ascend(parent);
  }
  return ascend(start);
}

const ROOT = repoRoot();
const SPEC_DIR = join(ROOT, "spec");
const CONTRACTS_DIR = join(SPEC_DIR, "contracts");

const LEDGER_HEADER = "id\tsurface\tstatus\tkind\tname\tobligation\tverification\tupstream\treference\tfinding";
const SURFACES_HEADER = "slug\tcapability\towns\tupstream_basis";
const MECHANISMS_HEADER = "mechanism\tupstream_evidence\tdisposition\tref\ttwin_surface";

const STATUS = new Set(["VERIFIED", "UNVERIFIED", "DEFECT", "EXCLUDED"]);
const KINDS = new Set(["tool", "command", "behavior", "ceiling"]);

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  function walk(p) {
    const names = readdirSync(p);
    const entries = names.map((n) => join(p, n));
    const files = entries.filter((e) => statSync(e).isFile());
    const dirs = entries.filter((e) => statSync(e).isDirectory());
    const sub = dirs.flatMap((d) => walk(d));
    return [...files, ...sub];
  }
  return walk(dir);
}

function readUtf8(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    return null;
  }
}

function splitLines(text) {
  if (text == null) return [];
  const raw = String(text).split(/\r?\n/);
  const last = raw.length > 0 ? raw[raw.length - 1] : undefined;
  const trimmed = last === "" ? raw.slice(0, raw.length - 1) : raw;
  return [...trimmed];
}

function toRel(abs) {
  return abs.startsWith(ROOT) ? relative(ROOT, abs) : abs;
}

function toAbsMaybe(relOrAbs) {
  return relOrAbs.startsWith("/") ? relOrAbs : join(ROOT, relOrAbs);
}

function unique(arr) {
  return [...new Set(arr)];
}

function parseNonOptInLayerDirs() {
  const regPath = join(ROOT, "tests/registry.mjs");
  const text = readUtf8(regPath);
  if (text == null) return { dirs: [], errors: ["missing tests/registry.mjs"] };
  const blocks = [...text.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
  const parseBlock = (b) => {
    const dirM = b.match(/\bdir:\s*"([^"]+)"/);
    const runnerM = b.match(/\brunner:\s*"([^"]+)"/);
    const optInM = b.match(/\boptIn:\s*true/);
    return dirM && runnerM && !optInM && runnerM[1] !== "commands" ? dirM[1] : null;
  };
  const dirs = unique(blocks.map(parseBlock).filter((d) => d != null));
  return { dirs, errors: [] };
}

function discoverTestFiles() {
  const { dirs, errors } = parseNonOptInLayerDirs();
  const discovered = dirs
    .map((d) => join(ROOT, d))
    .filter((p) => existsSync(p))
    .flatMap((p) => listFilesRecursive(p))
    .filter((f) => /\.test\.(mjs|ts)$/.test(f));
  const abs = unique(discovered).toSorted();
  const rel = abs.map(toRel);
  return { abs, rel, regErrors: errors };
}

function collectBindingIds() {
  const a = join(ROOT, "port/bindings/rules-a.mjs");
  const b = join(ROOT, "port/bindings/rules-benny.mjs");
  const texts = [readUtf8(a), readUtf8(b)];
  const ids = texts
    .filter((t) => t != null)
    .flatMap((t) => [...t.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]));
  return unique(ids);
}

function collectRegisteredToolNames() {
  const extDir = join(ROOT, "extensions");
  const files = listFilesRecursive(extDir).filter((p) => p.endsWith(".ts"));
  const texts = files.map(readUtf8).filter((t) => t != null);
  const names = texts.flatMap((t) => [...t.matchAll(/name:\s*"(pstack_[a-z_]+)"/g)].map((m) => m[1]));
  return unique(names);
}

function parseTsv(path) {
  const text = readUtf8(path);
  if (text == null) return { header: null, rows: [], missing: true };
  const lines = splitLines(text);
  if (lines.length === 0) return { header: null, rows: [], missing: false };
  const header = lines[0];
  const rows = lines.slice(1).map((line, i) => ({ line: i + 2, cols: line.split("\t") }));
  return { header, rows, missing: false };
}

function loadContracts() {
  const dir = CONTRACTS_DIR;
  const missingDir = !existsSync(dir);
  const files = missingDir
    ? []
    : unique(readdirSync(dir).map((n) => join(dir, n))).filter((p) => /\.tsv$/.test(p)).toSorted();
  const parsed = files.map((p) => ({ path: p, ...parseTsv(p) }));
  return { files, parsed, missingDir };
}

function validateLedger(parsedFiles) {
  const errors = [];
  const rows = parsedFiles.flatMap((pf) =>
    pf.rows
      .filter((r) => r.cols.filter((c) => c !== "").length > 0)
      .map((r) => ({ file: pf.path, line: r.line, cols: r.cols })),
  );
  if (parsedFiles.some((pf) => pf.header == null)) {
    const bad = parsedFiles.filter((pf) => pf.header == null).map((pf) => toRel(pf.path)).join(", ");
    const msg = bad.length ? `ledger files missing or empty: ${bad}` : "ledger missing";
    return { errors: [...errors, msg], rows: [] };
  }
  const badHeader = parsedFiles.filter((pf) => pf.header !== LEDGER_HEADER).map((pf) => toRel(pf.path));
  if (badHeader.length) return { errors: [...errors, `bad header in ${badHeader.join(", ")}`], rows: [] };

  const ids = rows.map((r) => r.cols[0]);
  const dupIds = ids.filter((id, i, arr) => arr.indexOf(id) !== i).toSorted();
  const idDupes = unique(dupIds);
  const errors2 = idDupes.length ? [...errors, `duplicate ids: ${idDupes.join(", ")}`] : errors;
  return { errors: errors2, rows };
}

function parseLedgerRow(r) {
  const [id, surface, status, kind, name, obligation, verification, upstream, reference, finding] = r.cols;
  return { id, surface, status, kind, name, obligation, verification, upstream, reference, finding, file: r.file, line: r.line };
}

function validateRowForm(rows) {
  const errs = [];
  const issues = rows.map(parseLedgerRow).flatMap((row) => {
    const idM = row.id && row.id.match(/^([a-z0-9_-]+)-(\d{2})$/);
    if (!idM) return [{ row, msg: `bad id format: ${row.id}` }];
    if (idM[1] !== row.surface) return [{ row, msg: `id prefix ${idM[1]} != surface ${row.surface}` }];
    if (!STATUS.has(row.status)) return [{ row, msg: `invalid status ${row.status}` }];
    if (!KINDS.has(row.kind)) return [{ row, msg: `invalid kind ${row.kind}` }];
    const isNameDashOk = row.kind === "behavior" || row.kind === "ceiling";
    if (isNameDashOk && row.name !== "-") return [{ row, msg: `name must be '-' for ${row.kind}` }];
    if (!isNameDashOk && (!row.name || row.name === "-")) return [{ row, msg: `name required for ${row.kind}` }];
    const obl = String(row.obligation ?? "");
    if (!obl.trim()) return [{ row, msg: "empty obligation" }];
    if (/\t/.test(obl)) return [{ row, msg: "obligation contains tab" }];
    if (/\r|\n/.test(obl)) return [{ row, msg: "obligation must be single line" }];
    return [];
  });
  const msgs = issues.map((i) => `${toRel(i.row.file)}:${i.row.line} ${i.msg}`);
  return msgs.length ? msgs : errs;
}

function loadDiscoveryContext() {
  const { abs, rel, regErrors } = discoverTestFiles();
  const files = new Set(abs);
  const relSet = new Set(rel);
  const mapAbsByRel = rel.reduce((acc, r, i) => {
    const prev = acc;
    const absPath = abs[i];
    return { ...prev, [r]: absPath };
  }, {});
  return { files, relSet, absList: abs, relList: rel, regErrors, mapAbsByRel };
}

function readFileSafe(absPath) {
  try {
    return readFileSync(absPath, "utf8");
  } catch (e) {
    return null;
  }
}

function parseVerifiedTestParts(v) {
  const parts = v.split("@");
  if (parts.length !== 3) return { err: "invalid test@ form" };
  const relOrAbs = parts[1];
  const needle = parts[2];
  if (/[@\t]/.test(needle) || !needle) return { err: "invalid test substring" };
  return { relOrAbs, needle };
}

function checkVerifiedRow(row, v, discovery, pkgScripts) {
  if (/^test@/.test(v)) {
    const p = parseVerifiedTestParts(v);
    if (p.err) return [`${row.id}: ${p.err}`];
    const absPath = p.relOrAbs.startsWith("/") ? p.relOrAbs : toAbsMaybe(p.relOrAbs);
    const isDiscovered = discovery.files.has(absPath) || discovery.relSet.has(p.relOrAbs);
    if (!existsSync(absPath)) return [`${row.id}: test file missing: ${p.relOrAbs}`];
    if (!isDiscovered) return [`${row.id}: test file not in discovered non-opt-in layers: ${p.relOrAbs}`];
    const text = readFileSafe(absPath);
    if (text == null || !text.includes(p.needle)) return [`${row.id}: substring not found in test file`];
    return [];
  }
  if (/^gate@/.test(v)) {
    const name = v.slice("gate@".length);
    if (!name) return [`${row.id}: empty gate script`];
    const exists = Object.prototype.hasOwnProperty.call(pkgScripts, name);
    return exists ? [] : [`${row.id}: missing npm script: ${name}`];
  }
  return [`${row.id}: VERIFIED must be test@ or gate@`];
}

function checkNonVerifiedRow(row, v) {
  if (row.status === "UNVERIFIED") return /^todo@\S/.test(v) ? [] : [`${row.id}: UNVERIFIED must be todo@text`];
  if (row.status === "DEFECT") {
    const ok = /^fix@#\d+$/.test(v) || /^fix@local:[a-z0-9_-]+$/.test(v);
    return ok ? [] : [`${row.id}: DEFECT must be fix@#<n> or fix@local:<slug>`];
  }
  if (row.status === "EXCLUDED") {
    const m = v.match(/^twin@([a-z0-9_-]+)$/);
    return m ? [] : [`${row.id}: EXCLUDED must be twin@<surface>`];
  }
  return [];
}

function excludedTwinSurfaceErrors(parsed, requireComplete) {
  if (!requireComplete) return [];
  const excl = parsed.filter((r) => r.status === "EXCLUDED");
  const twinSurf = excl.map((r) => r.verification.replace(/^twin@/, "")).filter((s) => s && s !== "-");
  const verifiedBySurface = parsed
    .filter((r) => r.status === "VERIFIED")
    .reduce((acc, r) => {
      const prev = acc[r.surface] ?? 0;
      return { ...acc, [r.surface]: prev + 1 };
    }, {});
  const missing = twinSurf.filter((s) => (verifiedBySurface[s] ?? 0) === 0);
  return missing.map((s) => `EXCLUDED twin surface lacks VERIFIED row: ${s}`);
}

function checkVerification(rows, discovery, pkgScripts, requireComplete) {
  const parsed = rows.map(parseLedgerRow);
  const errs = parsed.flatMap((row) => {
    const v = String(row.verification || "");
    if (row.status === "VERIFIED") return checkVerifiedRow(row, v, discovery, pkgScripts);
    return checkNonVerifiedRow(row, v);
  });
  const tail = excludedTwinSurfaceErrors(parsed, requireComplete);
  return [...errs, ...tail];
}

function checkToolCompleteness(rows) {
  const parsed = rows.map(parseLedgerRow);
  const toolRows = parsed.filter((r) => r.kind === "tool");
  const rowTools = unique(toolRows.map((r) => r.name));
  const registered = collectRegisteredToolNames();
  const missingRows = registered.filter((n) => !rowTools.includes(n)).toSorted();
  const unknownRows = rowTools.filter((n) => !registered.includes(n)).toSorted();
  const errs = [];
  const errs1 = missingRows.length ? [`missing kind=tool rows for: ${missingRows.join(", ")}`] : errs;
  const errs2 = unknownRows.length ? [...errs1, `ledger names unknown to extensions: ${unknownRows.join(", ")}`] : errs1;
  return errs2;
}

function loadSurfaces() {
  const p = join(SPEC_DIR, "surfaces.tsv");
  const t = readUtf8(p);
  if (t == null) return { header: null, slugs: [], missing: true };
  const lines = splitLines(t);
  if (lines.length === 0) return { header: null, slugs: [], missing: false };
  const header = lines[0];
  const slugs = lines.slice(1).map((l) => l.split("\t")[0]).filter((s) => s && s !== "-");
  return { header, slugs: unique(slugs), missing: false };
}

function checkSurfaceIntegrity(rows) {
  const surfaces = loadSurfaces();
  const specPath = join(SPEC_DIR, "SPEC.md");
  const specText = readUtf8(specPath) ?? "";
  const errs = [];
  if (surfaces.header == null) return ["missing spec/surfaces.tsv"];
  if (surfaces.header !== SURFACES_HEADER) return ["bad surfaces.tsv header"];
  const missingInSpec = surfaces.slugs.filter((s) => !specText.includes(s));
  const e1 = missingInSpec.length ? [`surfaces missing from SPEC.md: ${missingInSpec.join(", ")}`] : errs;
  const rowSurfaces = unique(rows.map((r) => r.cols[1]));
  const missingInTable = rowSurfaces.filter((s) => !surfaces.slugs.includes(s));
  const e2 = missingInTable.length ? [...e1, `row surfaces not in surfaces.tsv: ${missingInTable.join(", ")}`] : e1;
  return e2;
}

function parseMechanisms() {
  const p = join(SPEC_DIR, "mechanisms.tsv");
  const t = readUtf8(p);
  if (t == null) return { header: null, rows: [], missing: true };
  const lines = splitLines(t);
  if (lines.length === 0) return { header: null, rows: [], missing: false };
  const header = lines[0];
  const rows = lines.slice(1).map((l, i) => ({ line: i + 2, cols: l.split("\t") }));
  return { header, rows, missing: false };
}

function checkMechanisms(rows, requireComplete) {
  const mech = parseMechanisms();
  if (mech.header == null) return ["missing spec/mechanisms.tsv"];
  if (mech.header !== MECHANISMS_HEADER) return ["bad mechanisms.tsv header"];
  const bindings = collectBindingIds();
  const surfaces = loadSurfaces();
  const ledger = rows.map(parseLedgerRow);
  const errors = mech.rows.flatMap((r) => {
    const [mechanism, _evidence, disposition, ref, twin_surface] = r.cols;
    if (!mechanism) return [`mechanisms.tsv:${r.line} missing mechanism label`];
    if (!/^(binding|contract|excluded)$/.test(disposition)) return [`mechanisms.tsv:${r.line} invalid disposition: ${disposition}`];
    if (/^binding:/.test(ref)) {
      const id = ref.slice("binding:".length);
      if (!bindings.includes(id)) return [`mechanisms.tsv:${r.line} unknown binding id: ${id}`];
    } else if (/^rows:/.test(ref)) {
      if (ref === "rows:ceiling") {
        const ok = ledger.some((lr) => lr.status === "EXCLUDED" && lr.upstream === `mechanism:${mechanism}`);
        if (!ok) return [`mechanisms.tsv:${r.line} rows:ceiling not found for mechanism:${mechanism}`];
      } else {
        const surf = ref.slice("rows:".length);
        const ok = ledger.some((lr) => lr.surface === surf && lr.status !== "EXCLUDED");
        if (!ok) return [`mechanisms.tsv:${r.line} rows:${surf} has no non-EXCLUDED row`];
      }
    } else {
      return [`mechanisms.tsv:${r.line} invalid ref: ${ref}`];
    }
    if (disposition === "excluded") {
      if (!twin_surface || twin_surface === "-") return [`mechanisms.tsv:${r.line} excluded requires twin_surface`];
      if (!surfaces.slugs.includes(twin_surface)) return [`mechanisms.tsv:${r.line} twin_surface not in surfaces.tsv: ${twin_surface}`];
      if (requireComplete) {
        const ok = ledger.some((lr) => lr.surface === twin_surface && lr.status === "VERIFIED");
        if (!ok) return [`mechanisms.tsv:${r.line} twin surface lacks VERIFIED row: ${twin_surface}`];
      }
    } else {
      if (twin_surface && twin_surface !== "-") return [`mechanisms.tsv:${r.line} non-excluded must have '-' twin_surface`];
    }
    return [];
  });
  return errors;
}

function computeCoverage(rows) {
  const parsed = rows.map(parseLedgerRow);
  const total = parsed.length;
  const counts = parsed.reduce(
    (acc, r) => {
      const v = r.status === "VERIFIED" ? 1 : 0;
      const u = r.status === "UNVERIFIED" ? 1 : 0;
      const d = r.status === "DEFECT" ? 1 : 0;
      const e = r.status === "EXCLUDED" ? 1 : 0;
      return { V: acc.V + v, U: acc.U + u, D: acc.D + d, E: acc.E + e };
    },
    { V: 0, U: 0, D: 0, E: 0 },
  );
  const eligible = total - counts.E;
  const cov = eligible > 0 ? counts.V / eligible : 0;
  return { total, ...counts, eligible, coverage: cov };
}

function formatCoverage(cov) {
  const pct = cov.eligible > 0 ? Math.round((cov.coverage * 100 + Number.EPSILON) * 100) / 100 : 0;
  return `total=${cov.total} VERIFIED=${cov.V} UNVERIFIED=${cov.U} DEFECT=${cov.D} EXCLUDED=${cov.E} eligible=${cov.eligible} coverage=${pct}%`;
}

function openWorkQueue(rows) {
  const parsed = rows.map(parseLedgerRow);
  const open = parsed.filter((r) => r.status === "UNVERIFIED" || r.status === "DEFECT");
  return open.map((r) => `${r.id} ${r.status}`);
}

function groupRowsBySurface(rows) {
  const parsed = rows.map(parseLedgerRow);
  const surfaces = unique(parsed.map((r) => r.surface)).toSorted();
  return surfaces.map((s) => {
    const rs = parsed.filter((r) => r.surface === s);
    const lines = rs.map((r) => `${r.id}\t${r.status}\t${r.kind}\t${r.name}\t${r.verification}`);
    return { surface: s, lines };
  });
}

function parseArgs(argv) {
  const flags = argv.slice(2);
  const known = new Set(["--list", "--summary", "--require-complete"]);
  const unknown = flags.filter((f) => !known.has(f));
  if (unknown.length) return { ok: false, code: 2, msg: `unknown flags: ${unknown.join(", ")}` };
  return {
    ok: true,
    list: flags.includes("--list"),
    summary: flags.includes("--summary"),
    requireComplete: flags.includes("--require-complete"),
  };
}

function loadPkgScripts() {
  const pkgJsonText = readUtf8(join(ROOT, "package.json")) ?? "{}";
  try {
    const parsedPkg = JSON.parse(pkgJsonText);
    return parsedPkg && parsedPkg.scripts ? parsedPkg.scripts : {};
  } catch (e) {
    return {};
  }
}

function buildAllErrors(rows, parsedContracts, missingDir, discovery, pkgScripts, requireComplete) {
  const ledger0 = validateLedger(parsedContracts);
  const ledgerErrors = ledger0.errors;
  const rowFormErrors = ledger0.rows.length ? validateRowForm(ledger0.rows) : [];
  const verificationErrors = ledger0.rows.length
    ? checkVerification(ledger0.rows, discovery, pkgScripts, requireComplete)
    : [];
  const toolCompletenessErrors = ledger0.rows.length ? checkToolCompleteness(ledger0.rows) : [];
  const surfaceErrors = checkSurfaceIntegrity(ledger0.rows);
  const mechanismErrors = checkMechanisms(ledger0.rows, requireComplete);
  const dirErrs = missingDir ? ["missing spec/contracts directory"] : [];
  return [
    ...dirErrs,
    ...ledgerErrors,
    ...rowFormErrors,
    ...discovery.regErrors,
    ...verificationErrors,
    ...toolCompletenessErrors,
    ...surfaceErrors,
    ...mechanismErrors,
  ];
}

function renderOutput(args, rows, allErrors, cov) {
  const covLine = formatCoverage(cov);
  if (args.summary) {
    out(covLine);
    return;
  }
  if (args.list) {
    const groups = groupRowsBySurface(rows);
    const lines = groups.flatMap((g) => [g.surface, ...g.lines, ""]);
    for (const line of lines) out(line);
    out(covLine);
    return;
  }
  for (const e of allErrors) out(`ERROR: ${e}`);
  out(covLine);
  const open = openWorkQueue(rows);
  if (open.length) {
    out("open work:");
    for (const l of open) out(`  ${l}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.ok) {
    out(args.msg);
    process.exitCode = args.code;
    return;
  }
  const { parsed, missingDir } = loadContracts();
  const ledger0 = validateLedger(parsed);
  const rows = ledger0.rows;
  const discovery = loadDiscoveryContext();
  const pkgScripts = loadPkgScripts();
  const allErrors = buildAllErrors(rows, parsed, missingDir, discovery, pkgScripts, args.requireComplete);
  const cov = computeCoverage(rows);
  renderOutput(args, rows, allErrors, cov);
  const integrityFailed = allErrors.length > 0;
  const completeGateFailed = args.requireComplete && (cov.U !== 0 || cov.D !== 0 || cov.eligible === 0);
  process.exitCode = integrityFailed || completeGateFailed ? 1 : 0;
}

try {
  main();
} catch (e) {
  out(`ERROR: unexpected failure: ${e && e.message ? e.message : String(e)}`);
  process.exitCode = 1;
}
