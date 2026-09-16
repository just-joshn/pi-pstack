import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __setGuardPolicyForTests,
  evaluateGuard,
  parseGuardPolicy,
  registerPolicyGuard,
} from "../../../extensions/agents/policy-guard.ts";
import { compileTaskPolicy } from "../../../extensions/agents/policy.ts";

function guardFor(input: Parameters<typeof compileTaskPolicy>[0], role = "general") {
  return compileTaskPolicy(input, role);
}

function bash(command: string) {
  return { toolName: "bash", input: { command } };
}

function fakePi() {
  let handlers: Array<(event: { toolName: string; input: unknown }) => unknown> = [];
  return {
    pi: {
      on(event: string, handler: (event: { toolName: string; input: unknown }) => unknown) {
        if (event === "tool_call") handlers = [...handlers, handler];
      },
    },
    invoke(event: { toolName: string; input: unknown }) {
      return handlers[0]?.(event) as { block?: boolean; reason?: string } | undefined;
    },
    handlerCount: () => handlers.length,
  };
}

test("guard blocks filesystem, shell, git, and network writes", () => {
  const readOnly = guardFor(undefined, "comment-sicko");
  assert.equal(evaluateGuard(readOnly, { toolName: "write", input: {} })?.block, true);
  assert.equal(evaluateGuard(readOnly, { toolName: "edit", input: {} })?.block, true);
  assert.equal(evaluateGuard(readOnly, { toolName: "bash", input: { command: "ls" } })?.block, true);

  const shellNone = guardFor({ shell: "none" });
  assert.match(evaluateGuard(shellNone, bash("echo hi"))?.reason ?? "", /shell none blocks bash/);

  const gitRead = guardFor({ git: "read", shell: "full" });
  assert.match(evaluateGuard(gitRead, bash("git push origin main"))?.reason ?? "", /git policy read blocks 'git push'/);
  assert.equal(evaluateGuard(gitRead, bash("git log --oneline -5")), undefined);
  assert.equal(evaluateGuard(gitRead, bash("git status --porcelain")), undefined);

  const branchWrite = guardFor({ git: "branch-write", shell: "full" });
  assert.equal(evaluateGuard(branchWrite, bash("git commit -m 'wip'")), undefined);
  assert.equal(evaluateGuard(branchWrite, bash("git checkout -b feature/x")), undefined);
  assert.equal(evaluateGuard(branchWrite, bash("git branch new-branch")), undefined);
  assert.equal(evaluateGuard(branchWrite, bash("git push origin HEAD"))?.block, true);
  assert.equal(evaluateGuard(branchWrite, bash("git merge main"))?.block, true);

  const networkNone = guardFor({ network: "none", shell: "full" });
  assert.match(evaluateGuard(networkNone, bash("curl https://example.com"))?.reason ?? "", /network none blocks 'curl'/);
  assert.match(evaluateGuard(networkNone, bash("npm install left-pad"))?.reason ?? "", /network none blocks 'npm install'/);
  assert.match(evaluateGuard(networkNone, bash("pnpm add react"))?.reason ?? "", /network none blocks 'pnpm add'/);
  assert.match(evaluateGuard(networkNone, bash("git clone https://example.com/x.git"))?.reason ?? "", /network none blocks 'git clone'/);
  assert.match(evaluateGuard(networkNone, bash("gh pr create --fill"))?.reason ?? "", /network none blocks 'gh pr create'/);
});

test("guard allows the read paths each axis leaves open", () => {
  const networkNone = guardFor({ network: "none", shell: "full" });
  assert.equal(evaluateGuard(networkNone, bash("npm run test:unit")), undefined);
  assert.equal(evaluateGuard(networkNone, bash("git log --oneline")), undefined);
  assert.equal(evaluateGuard(networkNone, bash("gh pr view 12")), undefined);
  assert.equal(evaluateGuard(networkNone, bash("grep -rn nc src/")), undefined, "operands never look like commands");
  assert.equal(evaluateGuard(networkNone, bash("echo 'curl this' > notes.txt")), undefined);
  assert.equal(evaluateGuard(networkNone, { toolName: "read", input: {} }), undefined);

  const full = guardFor({ git: "merge" });
  assert.equal(evaluateGuard(full, { toolName: "edit", input: {} }), undefined);
  assert.equal(evaluateGuard(full, bash("git push origin main")), undefined);
  assert.equal(evaluateGuard(full, bash("curl https://example.com")), undefined);
});

test("guard reads git through flags and every command segment", () => {
  const gitRead = guardFor({ git: "read", shell: "full" });
  assert.match(
    evaluateGuard(gitRead, bash("git -C /repo push origin main"))?.reason ?? "",
    /blocks 'git push'/,
  );
  assert.match(
    evaluateGuard(gitRead, bash("cd /repo && git commit -m 'x'"))?.reason ?? "",
    /blocks 'git commit'/,
  );
  assert.match(
    evaluateGuard(gitRead, bash("sudo git reset --hard HEAD~1"))?.reason ?? "",
    /blocks 'git reset'/,
  );
});

test("integrations grant blocks a non-granted capability tool and allows a granted one", () => {
  const browserOnly = guardFor({ integrations: ["browser-ui"] });
  assert.equal(evaluateGuard(browserOnly, { toolName: "pstack_control_ui", input: {} }), undefined);
  assert.match(
    evaluateGuard(browserOnly, { toolName: "pstack_control_cli", input: {} })?.reason ?? "",
    /excludes cli-tui/,
  );
  assert.equal(evaluateGuard(browserOnly, { toolName: "read", input: {} }), undefined);

  const none = guardFor({ integrations: "none" });
  assert.match(
    evaluateGuard(none, { toolName: "pstack_control_ui", input: {} })?.reason ?? "",
    /integrations none excludes browser-ui/,
  );

  const inherited = guardFor({ integrations: "inherit" });
  assert.equal(evaluateGuard(inherited, { toolName: "pstack_control_cli", input: {} }), undefined);
});

test("malformed PSTACK_CHILD_POLICY blocks writes instead of silently allowing them", () => {
  const previous = process.env.PSTACK_CHILD_POLICY;
  try {
    for (const raw of ["{not json", JSON.stringify({ filesystem: "readwrite" })]) {
      process.env.PSTACK_CHILD_POLICY = raw;
      const env = fakePi();
      registerPolicyGuard(env.pi as never);
      assert.equal(env.handlerCount(), 1);
      const blocked = env.invoke({ toolName: "write", input: {} });
      assert.equal(blocked?.block, true, `expected a block for ${raw}`);
      assert.match(blocked?.reason ?? "", /PSTACK_CHILD_POLICY/);
      assert.equal(env.invoke({ toolName: "edit", input: {} })?.block, true);
      assert.equal(env.invoke({ toolName: "bash", input: { command: "rm -rf x" } })?.block, true);
      assert.equal(env.invoke({ toolName: "read", input: {} }), undefined, "reads cannot mutate");
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_POLICY");
    else process.env.PSTACK_CHILD_POLICY = previous;
    __setGuardPolicyForTests(null);
  }
});

test("registerPolicyGuard is a no-op when PSTACK_CHILD_POLICY is absent", () => {
  const previous = process.env.PSTACK_CHILD_POLICY;
  Reflect.deleteProperty(process.env, "PSTACK_CHILD_POLICY");
  __setGuardPolicyForTests(null);
  try {
    const env = fakePi();
    registerPolicyGuard(env.pi as never);
    assert.equal(env.handlerCount(), 0);
    assert.equal(env.invoke({ toolName: "write", input: {} }), undefined);
  } finally {
    if (previous !== undefined) process.env.PSTACK_CHILD_POLICY = previous;
  }
});

test("registerPolicyGuard applies the compiled env policy to the tool_call hook", () => {
  const previous = process.env.PSTACK_CHILD_POLICY;
  process.env.PSTACK_CHILD_POLICY = JSON.stringify(compileTaskPolicy({ git: "read", shell: "full" }, "general"));
  try {
    const env = fakePi();
    registerPolicyGuard(env.pi as never);
    assert.equal(env.invoke({ toolName: "write", input: {} }), undefined);
    assert.match(
      env.invoke({ toolName: "bash", input: { command: "git push" } })?.reason ?? "",
      /git policy read/,
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_POLICY");
    else process.env.PSTACK_CHILD_POLICY = previous;
    __setGuardPolicyForTests(null);
  }
});

test("__setGuardPolicyForTests drives the hook without spawning", () => {
  __setGuardPolicyForTests(compileTaskPolicy(undefined, "investigator"));
  try {
    const env = fakePi();
    registerPolicyGuard(env.pi as never);
    assert.equal(env.handlerCount(), 1);
    assert.equal(env.invoke({ toolName: "write", input: {} })?.block, true);
  } finally {
    __setGuardPolicyForTests(null);
  }
});

test("parseGuardPolicy reports schema failures without throwing", () => {
  assert.equal(parseGuardPolicy("not json").policy, undefined);
  assert.match(parseGuardPolicy("not json").blockReason ?? "", /not valid JSON/);
  assert.equal(parseGuardPolicy(JSON.stringify({ filesystem: "readwrite" })).policy, undefined);
  assert.match(parseGuardPolicy(JSON.stringify({ filesystem: "readwrite" })).blockReason ?? "", /failed policy validation/);
  const good = parseGuardPolicy(JSON.stringify(compileTaskPolicy(undefined, "comment-sicko")));
  assert.equal(good.blockReason, undefined);
  assert.equal(good.policy?.integrations, "none");
});
