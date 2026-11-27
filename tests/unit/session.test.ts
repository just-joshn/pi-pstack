import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { startPlan } from "../../src/lib/state.ts";
import { createSession } from "../../src/session.ts";
import { double, nth } from "../support.ts";

test("branch state can change only through commit, which saves and shows it", () => {
	const saved: unknown[] = [];
	const pi = double<ExtensionAPI>({
		on: () => () => {},
		appendEntry: (_, data) => saved.push(data),
	});
	const ctx = double<ExtensionContext>({ hasUI: false });
	const session = createSession(pi);
	const plan = startPlan("bug-fix", "repair");
	session.commit(ctx, { plan });
	const state = session.state();
	assert.throws(() => Object.assign(state, { goal: "unsaved" }), TypeError);
	assert.throws(() => state.plan?.tasks.push({ ...nth(plan.tasks, 0), id: 99 }), TypeError);
	assert.equal(saved.length, 1);
	plan.goal = "changed by the caller later";
	assert.equal(session.state().plan?.goal, "repair");
});
