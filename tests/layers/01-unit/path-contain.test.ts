import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedCwdRoots, assertPathContainment, isPathInside } from "../../../extensions/lib/path-contain.ts";
import { registerDecisionLog } from "../../../extensions/decision-log/index.ts";
import { prepareChildInput } from "../../../extensions/subagents/index.ts";

interface CapturedTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>;
}

function decisionLogHost(cwd: string): { tools: Map<string, CapturedTool>; ctx: { cwd: string } } {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool(definition: CapturedTool & { name: string }) {
      tools.set(definition.name, definition);
    },
    appendEntry() {},
  };
  registerDecisionLog(pi as never);
  return { tools, ctx: { cwd } };
}

function spawnHost(): never {
  return { getActiveTools: () => [] } as never;
}

function ctxFor(cwd: string) {
  return { model: { provider: "anthropic", id: "claude-parent-4-5" }, cwd, isProjectTrusted: () => true };
}

const MODEL = "anthropic/claude-sonnet-4-5";

test("isPathInside requires a separator boundary", () => {
  expect(isPathInside("/a/.pi", "/a/.pi/decisions.tsv")).toBe(true);
  expect(isPathInside("/a/.pi", "/a/.pi")).toBe(true);
  expect(isPathInside("/a/.pi", "/a/.pi-evil/x.tsv"), ".pi-evil must not pass a bare startsWith(.pi)").toBe(false);
  expect(isPathInside("/a/.pi", "/a/.piX")).toBe(false);
});

test("assertPathContainment resolves the longest existing ancestor for a missing leaf", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-contain-leaf-"));
  try {
    const root = join(dir, ".pi");
    const leaf = join(root, "audit", "deep", "row.tsv");
    expect(assertPathContainment(leaf, { root })).toBe(leaf);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertPathContainment refuses a symlink whose realpath leaves the root", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-contain-link-"));
  try {
    const root = join(dir, ".pi");
    const outside = join(dir, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "esc"), "dir");
    const escaped = join(root, "esc", "row.tsv");
    expect(() => assertPathContainment(escaped, { root })).toThrow(/escapes the workspace root/);
    expect(assertPathContainment(escaped, { root, allowedRoots: [outside] })).toBe(escaped);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision-log refuses the two-step symlinked .pi/esc write and leaves the target empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-declog-esc-"));
  try {
    const outside = join(dir, "outside");
    const piDir = join(dir, ".pi");
    mkdirSync(outside, { recursive: true });
    mkdirSync(piDir, { recursive: true });
    symlinkSync(outside, join(piDir, "esc"), "dir");
    const host = decisionLogHost(dir);
    const tool = host.tools.get("pstack_decision_log");
    expect(tool, "pstack_decision_log is registered").toBeTruthy();
    await expect(tool.execute(
        "audit",
        { path: ".pi/esc/x.tsv", phase: "audit", decision: "escape", why: "symlink" },
        undefined,
        undefined,
        host.ctx,
      )).rejects.toThrow(/must stay under/);
    expect(existsSync(join(outside, "x.tsv")), "nothing may land outside .pi").toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision-log still writes a normal .pi row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-declog-ok-"));
  try {
    const host = decisionLogHost(dir);
    const tool = host.tools.get("pstack_decision_log");
    expect(tool, "pstack_decision_log is registered").toBeTruthy();
    await tool.execute(
      "audit",
      { path: ".pi/audit/ok.tsv", phase: "p", decision: "d", why: "w" },
      undefined,
      undefined,
      host.ctx,
    );
    expect(existsSync(join(dir, ".pi", "audit", "ok.tsv"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareChildInput contains cwd and resumeSessionDir to the workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-spawn-root-"));
  const outside = mkdtempSync(join(tmpdir(), "pstack-spawn-outside-"));
  try {
    mkdirSync(join(root, "sub"), { recursive: true });
    const inside = join(root, "sub");
    const prepared = prepareChildInput({ task: "brief", model: MODEL, cwd: inside }, ctxFor(root), spawnHost());
    expect(prepared.childInput.cwd).toBe(inside);
    expect(() => prepareChildInput({ task: "brief", model: MODEL, cwd: outside }, ctxFor(root), spawnHost())).toThrow(/pstack_spawn cwd escapes the workspace root/);
    expect(() => prepareChildInput({ task: "brief", model: MODEL, resumeSessionDir: outside }, ctxFor(root), spawnHost())).toThrow(/resumeSessionDir escapes the workspace root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("PSTACK_ALLOWED_CWD admits an intentional second workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-hatch-root-"));
  const other = mkdtempSync(join(tmpdir(), "pstack-hatch-other-"));
  const prior = process.env.PSTACK_ALLOWED_CWD;
  process.env.PSTACK_ALLOWED_CWD = other;
  try {
    expect(allowedCwdRoots(root)).toEqual([other]);
    const prepared = prepareChildInput({ task: "brief", model: MODEL, cwd: other }, ctxFor(root), spawnHost());
    expect(prepared.childInput.cwd).toBe(other);
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process.env, "PSTACK_ALLOWED_CWD");
    else process.env.PSTACK_ALLOWED_CWD = prior;
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
