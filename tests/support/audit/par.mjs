/**
 * PAR-01..PAR-09: parity and correctness of the shipped surfaces themselves,
 * from the model tier map through the port checker and the skill text.
 */
import { readFileSync } from "node:fs";
import { Check } from "typebox/value";
import {
  fail,
  hostFor,
  importExtension,
  pass,
  repoPath,
  runProcess,
  verdict,
} from "./harness.mjs";

const OPUS = /opus/i;
const SONNET = /sonnet/i;
const STATUS_CALL = /ctx\.ui\.setStatus\(|setWorkingIndicator\(/;
const FRONTMATTER_FIELD = /\b(icon|color|reminder)\b/;
const CONFIG_BULLET = /^\s*-\s+`[a-zA-Z]+`\s*:/;

async function parModelTierMap() {
  const config = await importExtension("extensions/models/config.ts");
  const map = config.MARKETING_SLUG_MAP;
  const judgmentSlug = config.SKILL_DEFAULT_JUDGMENT;
  const judgmentId = map[judgmentSlug];
  if (!judgmentId) return fail(`SKILL_DEFAULT_JUDGMENT '${judgmentSlug}' has no MARKETING_SLUG_MAP entry`);
  const opusSlugs = Object.entries(map).filter(([, id]) => OPUS.test(id));
  if (!SONNET.test(judgmentId) || opusSlugs.length === 0) {
    return pass(`judgment slug '${judgmentSlug}' maps to ${judgmentId}; no weaker-tier inversion`);
  }
  const rivals = opusSlugs.map(([slug, id]) => `${slug} -> ${id}`).join(", ");
  return fail(
    `judgment slug '${judgmentSlug}' maps to ${judgmentId} (sonnet tier) while ${rivals} map to the stronger opus tier: the tier map is inverted`,
  );
}

function twelveWorkers() {
  return {
    workers: Array.from({ length: 12 }, (_unused, index) => ({ task: `worker ${index + 1}` })),
  };
}

async function parSwarmAcceptsMany() {
  const swarm = await importExtension("extensions/orchestration/swarm.ts");
  const host = hostFor(swarm.registerSwarm);
  const tool = host.tools.get("pstack_swarm");
  if (!tool) return fail("pstack_swarm is not registered");
  const accepted = Check(tool.parameters, twelveWorkers());
  return verdict(
    accepted,
    "pstack_swarm accepts a 12-worker request and batches it internally",
    "pstack_swarm hard-rejects 12 workers at the schema (maxItems 8) with no batching path, so N>8 is unreachable",
  );
}

function extensionSources() {
  const listing = readFileSync(repoPath("package.json"), "utf8");
  if (!listing.includes("extensions")) throw new Error("package.json no longer ships extensions/");
  return runProcess("git", ["ls-files", "extensions"]).then((run) =>
    run.stdout.split("\n").filter((name) => name.endsWith(".ts")),
  );
}

async function parSkillChromeRendered() {
  const files = await extensionSources();
  const sources = files.map((relative) => ({ relative, text: readFileSync(repoPath(relative), "utf8") }));
  const parses = sources.filter((entry) => FRONTMATTER_FIELD.test(entry.text));
  const statusCalls = sources.filter((entry) => STATUS_CALL.test(entry.text));
  const both = parses.filter((entry) => statusCalls.some((call) => call.relative === entry.relative));
  const frontmatter = readFileSync(repoPath("skills/poteto-mode/SKILL.md"), "utf8").split("---")[1] ?? "";
  const declared = ["icon", "color", "reminder"].filter((field) => frontmatter.includes(`${field}:`));
  return verdict(
    both.length > 0,
    `${both.map((entry) => entry.relative).join(", ")} parses and renders the skill chrome fields`,
    `SKILL.md declares ${declared.join(", ") || "(none)"} but no file under extensions/ reads icon/color/reminder; ${statusCalls.length} file(s) call setStatus with hardcoded values only`,
  );
}

async function parIntegrationsAdvertiseRegistered() {
  const entry = await importExtension("extensions/index.ts");
  const host = hostFor(entry.default);
  const tool = host.tools.get("pstack_integrations");
  if (!tool) return fail("pstack_integrations is not registered");
  const result = await tool.execute("audit", { action: "status" }, undefined, undefined, host.ctx());
  const advertised = (result.details?.categories ?? []).map((category) => category.tool);
  const registered = new Set(host.tools.keys());
  const missing = advertised.filter((name) => !registered.has(name));
  return verdict(
    missing.length === 0,
    `all ${advertised.length} advertised capability tools are registered`,
    `${missing.length}/${advertised.length} advertised capability tools are never registered: ${missing.join(", ")}`,
  );
}

function identicalBranchBody(source) {
  const start = source.indexOf("if (localBuf.equals(upstreamBuf)) {");
  if (start < 0) throw new Error("port/port.mjs no longer contains the byte-identical early return");
  const end = source.indexOf("\n  }", start);
  return source.slice(start, end < 0 ? source.length : end);
}

async function parPortScansIdentical() {
  const source = readFileSync(repoPath("port/port.mjs"), "utf8");
  const body = identicalBranchBody(source);
  return verdict(
    body.includes("scanLeftovers("),
    "the byte-identical branch scans for leftovers before returning",
    `the byte-identical early return skips scanLeftovers entirely: ${body.split("\n").map((line) => line.trim()).join(" ")}`,
  );
}

async function parSwarmSkillText() {
  const text = readFileSync(repoPath("skills/swarm/SKILL.md"), "utf8");
  const phrase = "accepts at most 8 per call";
  return verdict(
    !text.includes(phrase),
    "skills/swarm/SKILL.md does not restate the upstream N-per-call claim",
    `skills/swarm/SKILL.md still says "${phrase}", contradicting the upstream contract that N is the worker total`,
  );
}

function configBlocks(lines) {
  const collected = lines.reduce(
    (acc, line, index) => {
      if (CONFIG_BULLET.test(line)) {
        return { blocks: acc.blocks, current: [...acc.current, { line, number: index + 1 }] };
      }
      return acc.current.length ? { blocks: [...acc.blocks, acc.current], current: [] } : acc;
    },
    { blocks: [], current: [] },
  );
  return [...collected.blocks, ...(collected.current.length ? [collected.current] : [])];
}

function describeConflict(block) {
  const spawn = block.find((entry) => entry.line.includes("pstack_spawn"));
  const task = block.find((entry) => entry.line.includes("pstack_task"));
  return `lines ${spawn.number}+${task.number} (${spawn.line.trim().slice(0, 40)} / ${task.line.trim().slice(0, 40)})`;
}

async function parWhySpawnTool() {
  const lines = readFileSync(repoPath("skills/why/SKILL.md"), "utf8").split("\n");
  const blocks = configBlocks(lines);
  const conflicted = blocks.filter(
    (block) =>
      block.some((entry) => entry.line.includes("pstack_spawn")) &&
      block.some((entry) => entry.line.includes("pstack_task")),
  );
  return verdict(
    conflicted.length === 0,
    `all ${blocks.length} subagent config blocks in skills/why/SKILL.md name a single spawn tool`,
    `${conflicted.length}/${blocks.length} config blocks name both pstack_spawn and pstack_task for one subagent: ${conflicted.map(describeConflict).join(" ; ")}`,
  );
}

async function parWorktreeAuditScope() {
  const path = "skills/poteto-mode/scripts/worktree-audit.sh";
  const text = readFileSync(repoPath(path), "utf8");
  const unscoped = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => /\$HOME\/\.pi\/agent\/sessions|~\/\.pi\/agent\/sessions/.test(line));
  return verdict(
    unscoped.length === 0,
    `${path} never walks the whole session store`,
    `${path} reads the entire session store unscoped: ${unscoped.map((line) => line.trim()).join(" | ")}`,
  );
}

async function parParityGateClean() {
  const run = await runProcess("npm", ["run", "--silent", "parity:check"]);
  const clean = /\b0 drift\b/.test(run.stdout) && /\b0 loose\b/.test(run.stdout);
  const summary = run.stdout.trim().split("\n").at(-3) ?? run.stdout.trim();
  return verdict(
    run.code === 0 && clean,
    `parity:check exits 0 with 0 drift and 0 loose: ${summary}`,
    `parity:check exited ${run.code}; drift/loose not both zero: ${summary}`,
  );
}

export const PAR_PREDICATES = Object.freeze([
  { id: "PAR-01", description: "the model tier map does not route judgment to a weaker tier", run: parModelTierMap },
  { id: "PAR-02", description: "pstack_swarm accepts N>8 workers instead of hard-rejecting", run: parSwarmAcceptsMany },
  { id: "PAR-03", description: "skill frontmatter icon/color/reminder reach a host UI call", run: parSkillChromeRendered },
  { id: "PAR-04", description: "pstack_integrations advertises only tools the extension registers", run: parIntegrationsAdvertiseRegistered },
  { id: "PAR-05", description: "port.mjs scans byte-identical files for leftovers", run: parPortScansIdentical },
  { id: "PAR-06", description: "skills/swarm/SKILL.md does not contradict upstream on N", run: parSwarmSkillText },
  { id: "PAR-07", description: "skills/why/SKILL.md names one spawn tool per subagent config", run: parWhySpawnTool },
  { id: "PAR-08", description: "worktree-audit.sh is workspace-scoped, not whole-session-store", run: parWorktreeAuditScope },
  { id: "PAR-09", description: "npm run parity:check exits 0 with 0 drift and 0 loose", run: parParityGateClean },
]);
