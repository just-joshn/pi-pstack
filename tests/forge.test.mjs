import assert from "node:assert/strict";
import test from "node:test";

import { host, readResult } from "./host.mjs";

const head = "a".repeat(40);
const baseUrl = "https://example.invalid/team/project/pull/";
const proofs = [1, 2, 3].map((number) => ({
  number,
  head,
  evidence: "checked",
  independent: true,
}));
const unavailable = { code: 0, truncated: true, stdout: "", stderr: "" };

async function shipping(onRead) {
  const attempts = [];
  const offers = [];
  const h = host({
    confirm: (_, message) => {
      offers.push(JSON.parse(message).map((proof) => proof.number));
      return true;
    },
    execute: async (bin, args) => {
      assert.equal(bin, "gh");
      const id = args[2];
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
    ship: (signal) => h.call("pstack_ship", { proofs }, signal).then(readResult),
  };
}

async function completeTasks(h) {
  for (const task of h.entries.at(-1).data.plan.tasks) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each transition updates the same plan.
    await h.call("pstack_plan", {
      action: "update",
      task: task.id,
      status: "done",
      evidence: "checked",
    });
  }
}

void test("a finished shipping plan cannot preview a new stack, including after restore", async () => {
  const h = host();
  await h.cmd("pstack-run", "shipping Close this stack");
  await completeTasks(h);
  await h.call("pstack_plan", { action: "finish", evidence: "stack closed" });
  const ship = () => h.call("pstack_ship", { proofs });
  await assert.rejects(ship, /requires a shipping or autopilot-full plan/);
  await h.events.get("session_tree")({}, h.ctx);
  await assert.rejects(ship, /requires a shipping or autopilot-full plan/);
  assert.equal(h.executions.length, 0);
});

void test("finishing a plan while approval is pending stops the approved stack", async () => {
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

void test("an initial lookup failure ends the approval prefix at the last verified PR", async () => {
  const h = await shipping((n, phase) =>
    n === 2 && phase === "preview" ? unavailable : undefined,
  );
  const result = await h.ship();
  assert.deepEqual(h.offers, [[1]]);
  assert.deepEqual(h.attempts, [1]);
  assert.deepEqual(result.merged, [{ number: 1, head, url: `${baseUrl}1` }]);
  assert.deepEqual(result.unmerged, [2, 3]);
  assert.equal(result.lookupFailure.number, 2);
  assert.match(result.lookupFailure.error, /gh pr view failed/);
});

void test("a lookup failure at the first PR never offers later PRs", async () => {
  const h = await shipping((n) => (n === 1 ? unavailable : undefined));
  await assert.rejects(() => h.ship(), /gh pr view failed/);
  assert.deepEqual(h.offers, []);
  assert.deepEqual(h.attempts, []);
});

void test("cancelling preview does not offer an already verified prefix", async () => {
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

for (const phase of ["recheck", "receipt"]) {
  void test(`a failed ${phase} for an approved PR preserves confirmed progress`, async () => {
    const h = await shipping((n, stage) => (n === 2 && phase === stage ? unavailable : undefined));
    const result = await h.ship();
    assert.deepEqual(result.merged, [{ number: 1, head, url: `${baseUrl}1` }]);
    assert.equal(result.stopped, 2);
    assert.match(result.error, /gh pr view failed/);
    if (phase === "receipt") {
      assert.equal(result.unconfirmed, 2);
      assert.match(result.reason, /inspect forge state/);
      assert.deepEqual(result.unmerged, [3]);
      assert.deepEqual(h.attempts, [1, 2]);
    } else {
      assert.equal(result.unconfirmed, undefined);
      assert.match(result.reason, /readiness/);
      assert.deepEqual(result.unmerged, [2, 3]);
      assert.deepEqual(h.attempts, [1]);
    }
  });
}

void test("a MERGED receipt for a different head stops the stack as unconfirmed", async () => {
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
