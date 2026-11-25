import assert from "node:assert/strict";

import { describe, test } from "vitest";

import { verifiedPrefix } from "../src/forge.ts";
import { type Host, host, type HostOptions, readResult, type Run, shipped } from "./host.ts";
import { shaped } from "./support.ts";

const readyProof = (n: number) => ({
  number: n,
  head: `sha${n}`,
  evidence: "actual run",
  independent: true,
});
const readyPr = (n: number) => ({
  number: n,
  url: `https://example.invalid/pull/${n}`,
  headRefOid: `sha${n}`,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
});

const head = "a".repeat(40);
const baseUrl = "https://example.invalid/team/project/pull/";
const proofs = [1, 2, 3].map((number) => ({
  number,
  head,
  evidence: "checked",
  independent: true,
}));
const unavailable = { code: 0, truncated: true, stdout: "", stderr: "" };
type Phase = "preview" | "recheck" | "receipt";
interface Status {
  number: number;
  url: string;
  headRefOid: string;
  state: string;
}

async function shipping(onRead: (number: number, phase: Phase, status: Status) => Run | undefined) {
  const attempts: number[] = [];
  const offers: number[][] = [];
  const h = host({
    confirm: (_, message) => {
      offers.push(shaped<{ number: number }[]>(JSON.parse(message)).map((proof) => proof.number));
      return true;
    },
    execute: async (bin, args) => {
      assert.equal(bin, "gh");
      const id = args[2] ?? "";
      const number = Number(id.split("/").at(-1));
      if (args[1] === "merge") {
        attempts.push(number);
        return { code: 0, stdout: "", stderr: "" };
      }
      const merged = attempts.includes(number);
      const phase = id === String(number) ? "preview" : merged ? "receipt" : "recheck";
      const status = {
        number,
        url: `${baseUrl}${number}`,
        headRefOid: head,
        state: merged ? "MERGED" : "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ state: "SUCCESS" }],
      };
      return (
        onRead(number, phase, status) ?? { code: 0, stdout: JSON.stringify(status), stderr: "" }
      );
    },
  });
  await h.cmd("pstack-run", "shipping Merge checked heads");
  return {
    host: h,
    offers,
    attempts,
    ship: async (signal?: AbortSignal) => shipped(await h.call("pstack_ship", { proofs }, signal)),
  };
}

async function completeTasks(h: Host) {
  for (const task of h.state().plan?.tasks ?? []) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each transition updates the same plan.
    await h.call("pstack_plan", {
      action: "update",
      task: task.id,
      status: "done",
      evidence: "checked",
    });
  }
}

/** A GitHub fake that merges PR 1 and moves PR 2 to a new head once the stack is approved. */
function changingForge(url: string): HostOptions {
  let approved = false;
  const merged = new Set<number>();
  return {
    mode: "rpc",
    confirm: (_, message) => {
      assert.deepEqual(
        shaped<{ url: string }[]>(JSON.parse(message)).map((proof) => proof.url),
        [`${url}1`, `${url}2`],
      );
      approved = true;
      return true;
    },
    execute: async (bin, args) => {
      assert.equal(bin, "gh");
      assert.equal(args[0], "pr");
      const number = Number(args[2]?.split("/").at(-1));
      if (args[1] === "merge") {
        assert.deepEqual(args, ["pr", "merge", `${url}1`, "--merge", "--match-head-commit", head]);
        merged.add(number);
        return { code: 0, stdout: "", stderr: "" };
      }
      assert.equal(args[2], approved ? `${url}${number}` : String(number));
      const status = {
        number,
        url: `${url}${number}`,
        headRefOid: approved && number === 2 ? "b".repeat(40) : head,
        state: merged.has(number) ? "MERGED" : "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      };
      return { code: 0, stdout: JSON.stringify(status), stderr: "" };
    },
  };
}

describe("shipping gate", () => {
  test("a finished shipping plan cannot preview a new stack, including after restore", async () => {
    const h = host();
    await h.cmd("pstack-run", "shipping Close this stack");
    await completeTasks(h);
    await h.call("pstack_plan", { action: "finish", evidence: "stack closed" });
    const ship = () => h.call("pstack_ship", { proofs });
    await assert.rejects(ship, /requires a shipping or autopilot-full plan/);
    h.emit("session_tree");
    await assert.rejects(ship, /requires a shipping or autopilot-full plan/);
    assert.equal(h.executions.length, 0);
  });
  test("finishing a plan while approval is pending stops the approved stack", async () => {
    const stack = await shipping(() => undefined);
    await completeTasks(stack.host);
    stack.host.ctx.ui.confirm = async () => {
      await stack.host.call("pstack_plan", { action: "finish", evidence: "stack closed" });
      return true;
    };
    const result = await stack.ship();
    assert.deepEqual(stack.attempts, []);
    assert.deepEqual(
      result.unmerged,
      proofs.map((p) => p.number),
    );
    assert.equal(result.stopped, 1);
  });
  test("an initial lookup failure ends the approval prefix at the last verified PR", async () => {
    const h = await shipping((n, phase) =>
      n === 2 && phase === "preview" ? unavailable : undefined,
    );
    const result = await h.ship();
    assert.deepEqual(h.offers, [[1]]);
    assert.deepEqual(h.attempts, [1]);
    assert.deepEqual(result.merged, [{ number: 1, head, url: `${baseUrl}1` }]);
    assert.deepEqual(result.unmerged, [2, 3]);
    assert.equal(result.lookupFailure?.number, 2);
    assert.match(result.lookupFailure.error, /gh pr view failed/);
  });
  test("a lookup failure at the first PR never offers later PRs", async () => {
    const h = await shipping((n) => (n === 1 ? unavailable : undefined));
    await assert.rejects(() => h.ship(), /gh pr view failed/);
    assert.deepEqual(h.offers, []);
    assert.deepEqual(h.attempts, []);
  });
  test("cancelling preview does not offer an already verified prefix", async () => {
    const controller = new AbortController();
    const h = await shipping((n) => {
      if (n !== 2) return undefined;
      controller.abort(new Error("review cancelled"));
      return unavailable;
    });
    await assert.rejects(() => h.ship(controller.signal), /review cancelled/);
    assert.deepEqual(h.offers, []);
    assert.deepEqual(h.attempts, []);
  });
  for (const phase of ["recheck", "receipt"] as const)
    test(`a failed ${phase} for an approved PR preserves confirmed progress`, async () => {
      const h = await shipping((n, stage) =>
        n === 2 && phase === stage ? unavailable : undefined,
      );
      const result = await h.ship();
      assert.deepEqual(result.merged, [{ number: 1, head, url: `${baseUrl}1` }]);
      assert.equal(result.stopped, 2);
      assert.match(result.error ?? "", /gh pr view failed/);
      if (phase === "receipt") {
        assert.equal(result.unconfirmed, 2);
        assert.match(result.reason ?? "", /inspect forge state/);
        assert.deepEqual(result.unmerged, [3]);
        assert.deepEqual(h.attempts, [1, 2]);
      } else {
        assert.equal(result.unconfirmed, undefined);
        assert.match(result.reason ?? "", /readiness/);
        assert.deepEqual(result.unmerged, [2, 3]);
        assert.deepEqual(h.attempts, [1]);
      }
    });
  test("a MERGED receipt for a different head stops the stack as unconfirmed", async () => {
    const h = await shipping((n, phase, status) => {
      if (n !== 2 || phase !== "receipt") return undefined;
      return {
        code: 0,
        stdout: JSON.stringify({ ...status, headRefOid: "b".repeat(40) }),
        stderr: "",
      };
    });
    const result = await h.ship();
    assert.deepEqual(result.merged, [{ number: 1, head, url: `${baseUrl}1` }]);
    assert.equal(result.unconfirmed, 2);
    assert.deepEqual(result.unmerged, [3]);
    assert.deepEqual(h.attempts, [1, 2]);
  });

  test("RPC shipping pins approved repository URLs and stops before merging a changed head", async () => {
    const url = "https://github.com/team/project/pull/";
    const h = host(changingForge(url));
    await h.cmd("pstack-run", "shipping Merge checked heads");
    const pinned = [1, 2].map((number) => ({
      number,
      head,
      evidence: "local check",
      independent: true,
    }));
    const outcome = shipped(await h.call("pstack_ship", { proofs: pinned }));
    assert.deepEqual(
      outcome.merged.map((entry) => entry.number),
      [1],
    );
    assert.deepEqual(outcome.unmerged, [2]);
    assert.equal(outcome.stopped, 2);
  });

  test("RPC shipping refuses duplicates, missing evidence and a declined confirmation without merging", async () => {
    const h = host({
      mode: "rpc",
      execute: async (_, args) => {
        assert.equal(args[1], "view");
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            number: 1,
            url: "https://github.com/team/project/pull/1",
            headRefOid: head,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            statusCheckRollup: [{ state: "SUCCESS" }],
          }),
        };
      },
    });
    await h.cmd("pstack-run", "shipping Merge reviewed head");
    const proof = { number: 1, head, independent: true, evidence: "test passed" };
    await assert.rejects(() => h.call("pstack_ship", { proofs: [proof, proof] }), /Duplicate PR/);
    assert.equal(h.executions.length, 0);
    await assert.rejects(
      () => h.call("pstack_ship", { proofs: [{ ...proof, evidence: "" }] }),
      /No verified merge-ready prefix/,
    );
    await assert.rejects(() => h.call("pstack_ship", { proofs: [proof] }), /Merge not authorized/);
    assert.equal(h.executions.length, 2);
  });

  test("a malformed forge response is rejected rather than treated as merge-ready", async () => {
    const h = host({ execute: async () => ({ code: 0, stdout: '{"number":1}', stderr: "" }) });
    await assert.rejects(() => h.call("pstack_pr", { number: 1 }), /Unexpected GitHub PR response/);
  });

  test("PR inspection preserves a null check rollup, but shipping still requires checks", async () => {
    const pr = {
      number: 1,
      url: "https://github.com/team/project/pull/1",
      headRefOid: "a".repeat(40),
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: null,
    };
    const h = host({
      confirm: () => assert.fail("Shipping must not request approval for missing checks"),
      execute: async (bin, args) => {
        assert.equal(bin, "gh");
        assert.equal(args[1], "view");
        return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
      },
    });
    assert.deepEqual(readResult(await h.call("pstack_pr", { number: pr.number })), pr);
    await h.cmd("pstack-run", "shipping Merge reviewed head");
    const proof = {
      number: pr.number,
      head: pr.headRefOid,
      independent: true,
      evidence: "test passed",
    };
    await assert.rejects(
      () => h.call("pstack_ship", { proofs: [proof] }),
      /No verified merge-ready prefix/,
    );
  });

  test("shipping stops at stale head, missing proof, failing checks or noncontiguous prefix", () => {
    const ready = [readyProof(1), readyProof(2), readyProof(3)],
      statuses = [readyPr(1), readyPr(2), readyPr(3)];
    assert.equal(verifiedPrefix(ready, statuses).length, 3);
    for (const patch of [
      { headRefOid: "changed" },
      { statusCheckRollup: [] },
      { mergeStateStatus: "BLOCKED" },
      { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
      { isDraft: true },
    ])
      assert.equal(
        verifiedPrefix(ready, [readyPr(1), { ...readyPr(2), ...patch }, readyPr(3)]).length,
        1,
      );
    assert.equal(verifiedPrefix([{ ...readyProof(1), independent: false }], statuses).length, 0);
    assert.equal(verifiedPrefix([{ ...readyProof(1), evidence: "" }], statuses).length, 0);
  });
});
