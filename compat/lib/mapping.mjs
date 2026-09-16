/** Ledger row -> parity row field derivation. The mapping rules are the contract. */

export const CLASSIFICATIONS = [
  "EXACT-CONTRACT",
  "ADAPTED-EQUIVALENT",
  "HOSTED-CAPABILITY-REQUIRED",
  "APPROVED-EXCEPTION",
];

export const STATUSES = ["unimplemented", "implemented", "verified", "blocked"];

export const CATEGORIES = [
  "skill",
  "agent",
  "playbook",
  "command",
  "config",
  "state",
  "integration",
  "dependency",
  "edge-case",
];

const MECHANISM_PREFIX = "mechanism:";

const SCOPED_PREFIXES = ["skills/", "agents/", "automations/", "docs/", "assets/"];

const ROOT_ARTIFACTS = new Set(["README.md", "LICENSE", ".gitignore", ".cursor-plugin/plugin.json"]);

const SURFACE_CATEGORY = {
  content: "dependency",
  commands: "command",
  decision: "skill",
  sticky: "skill",
  spawn: "agent",
  jobs: "agent",
  swarm: "agent",
  arena: "agent",
  models: "config",
  loop: "skill",
  worktree: "skill",
  ship: "skill",
  babysit: "skill",
  gates: "skill",
  deslop: "skill",
  control: "skill",
  readonly: "skill",
  sessions: "state",
  benny: "integration",
  ceiling: "edge-case",
};

const SERVICE_BY_MECHANISM = {
  "cloud-agents": "services/worker",
  mcp: "services/worker",
  "durable-jobs": "services/worker",
  "ide-driving": "services/worker",
  "automations-slack": "services/benny",
  "grok-bot": "services/benny",
};

const NORMALIZATION_TOKENS = [
  "absolute temp paths",
  "timestamps",
  "durations",
  "40-hex SHAs",
];

/** One sentence per SPEC.md section 4 divergence row, keyed by the ledger row that encodes it. */
const DIVERGENCE_BY_ID = {
  "ship-04":
    "Merge gates are deliberately stricter than the ported watch-pr policy, so BLOCKED and BEHIND block a merge because a merge is irreversible.",
  "ship-06":
    "Merge gates are deliberately stricter than the ported watch-pr policy, so pending checks block a merge because a merge is irreversible.",
  "ship-07":
    "Merge gates are deliberately stricter than the ported watch-pr policy, so REVIEW_REQUIRED blocks a merge because a merge is irreversible.",
  "worktree-14":
    "Shutdown cleanup deliberately skips untracked-only worktrees because deleting untracked files loses work the agent never committed.",
  "sticky-12":
    "Sticky mode deliberately injects the prompt on every turn while armed because re-entry gating is the only reliable way to keep a sticky mode armed across a host that re-fires input.",
  "readonly-07":
    "Readonly deliberately blocks a named tool set and coerces spawns because Pi has no host Ask mode, so the extension owns the policy for tools that write or exec.",
  "commands-04":
    "Skill name frontmatter is deliberately kebab-case because Pi requires a-z0-9- while the slash command stays the same.",
};

export function isUpstreamPath(value) {
  return SCOPED_PREFIXES.some((prefix) => value.startsWith(prefix)) || ROOT_ARTIFACTS.has(value);
}

export function isMechanismCell(value) {
  return value.startsWith(MECHANISM_PREFIX);
}

export function mechanismName(value) {
  return isMechanismCell(value) ? value.slice(MECHANISM_PREFIX.length) : "";
}

export function categorize(row) {
  if (row.upstream.includes("playbooks/")) return "playbook";
  if (row.upstream.startsWith("docs/")) return "skill";
  if (row.reference.includes("/scripts/")) return "dependency";
  if (row.kind === "tool" || row.kind === "command") return "command";
  return SURFACE_CATEGORY[row.surface] ?? "skill";
}

export function statusFor(cell, classCell) {
  if (cell === "VERIFIED") return "verified";
  if (cell === "UNVERIFIED") return "implemented";
  if (cell === "DEFECT") return "blocked";
  if (cell === "EXCLUDED" && classCell === "ADAPTED-EQUIVALENT") return "verified";
  if (cell === "EXCLUDED" && classCell === "HOSTED-CAPABILITY-REQUIRED") return "unimplemented";
  if (cell === "EXCLUDED" && classCell === "APPROVED-EXCEPTION") return "blocked";
  return null;
}

export function upstreamPathFor(row) {
  return isMechanismCell(row.upstream) ? mechanismName(row.upstream) : row.upstream;
}

export function prerequisitesFor(row, mechanism) {
  if (row.class !== "HOSTED-CAPABILITY-REQUIRED") return [];
  const service = SERVICE_BY_MECHANISM[mechanism];
  if (!service) return [];
  const twin = row.verification.startsWith("twin@") ? row.verification.slice("twin@".length) : "local";
  return [service, `twin surface ${twin} is the local fallback; the hosted path is ${service}, proven by tests/hosted`];
}

/**
 * Authored corrections for ledger obligations that rest on a premise the code
 * contradicts. The ledger TSV is frozen against the pinned upstream here, so the
 * projection carries the corrected sentence while the ledger row stays the
 * follow-up at the source. A correction applies only while `stalePremise` is
 * still present, so fixing the ledger retires it automatically.
 */
const OBLIGATION_CORRECTIONS_BY_ID = {
  "ceiling-06": {
    stalePremise: "frontmatter schema is closed",
    replacement:
      "Cursor renders reminder, mode, icon, and color from skill frontmatter through its host skill loader. Pi's skill loader consumes only name, description, and disable-model-invocation, so this tree reads those keys from SKILL.md (extensions/lib/skill-chrome.ts) and renders them through the extension: the sticky prompt carries the reminder and the status line carries icon and color, while the sticky extension reproduces the mode bit; the residual exception is the host render path, not a dropped field.",
  },
};

export function obligationFor(row) {
  const correction = OBLIGATION_CORRECTIONS_BY_ID[row.id];
  if (!correction || !row.obligation.includes(correction.stalePremise)) return row.obligation;
  return correction.replacement;
}

export function normalizationFor(row) {
  return row.verification.startsWith("gate@test:differential") ? [...NORMALIZATION_TOKENS] : [];
}

export function divergencesFor(rowId) {
  const sentence = DIVERGENCE_BY_ID[rowId];
  return sentence ? [sentence] : [];
}

export function observableContractFor(row) {
  return row.kind === "tool" || row.kind === "command" ? [row.name] : [row.verification];
}

export function referenceList(cell) {
  return cell === "-" ? [] : [cell];
}

export function testsFor(row) {
  return row.verification.startsWith("test@") ? [row.verification] : [];
}
