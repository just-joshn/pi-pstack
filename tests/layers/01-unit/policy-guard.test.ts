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

test("filesystem read-only blocks mutating bash commands, not just write and edit", () => {
  const readOnly = guardFor({ filesystem: "read-only", shell: "full" });
  const mutators = [
    "echo pwned > /tmp/f",
    "echo x >> /tmp/f",
    "rm -rf /tmp/d",
    "mv a b",
    "cp a b",
    "dd if=/dev/zero of=/tmp/f",
    "truncate -s0 /tmp/f",
    "sed -i s/a/b/ f",
    "sed -i.bak s/a/b/ f",
    "sed --in-place=.bak s/a/b/ f",
    "curl -o/tmp/f https://example.com",
    "busybox rm -rf /tmp/d",
    "python3 -c 'open(\"/tmp/f\",\"w\")'",
    "$'\\x72\\x6d' -rf /tmp/d",
    "tee /tmp/f",
    "mkdir /tmp/d",
    "touch /tmp/f",
    "chmod 777 f",
    "ln -s a b",
    "git checkout -- .",
  ];
  const leaks = mutators.filter((command) => evaluateGuard(readOnly, bash(command))?.block !== true);
  assert.deepEqual(leaks, [], "every mutating command must be blocked");

  assert.equal(evaluateGuard(readOnly, bash("ls -la")), undefined);
  assert.equal(evaluateGuard(readOnly, bash("grep -rn pattern src/")), undefined);
  assert.equal(evaluateGuard(readOnly, bash("sed -n 1p file")), undefined, "sed without -i only reads");
  assert.equal(evaluateGuard(readOnly, bash("git log --oneline -5")), undefined);
});

test("git read blocks pushes hidden behind separators, wrappers, and substitutions", () => {
  const gitRead = guardFor({ git: "read", shell: "full" });
  const hidden = [
    "git status\ngit push origin main",
    'bash -c "git push origin main"',
    "sh -c 'git push'",
    'zsh -c "git push"',
    'env bash -c "git push"',
    "$(git push origin main)",
    "`git push origin main`",
    "x=$(git push)",
    "if [ -f x ]; then git push; fi",
  ];
  const leaks = hidden.filter((command) => evaluateGuard(gitRead, bash(command))?.block !== true);
  assert.deepEqual(leaks, [], "every hidden push must be blocked");
});

test("git read refuses a subcommand it cannot resolve instead of allowing it", () => {
  const gitRead = guardFor({ git: "read", shell: "full" });
  assert.match(
    evaluateGuard(gitRead, bash("git $SUB origin main"))?.reason ?? "",
    /cannot verify a git subcommand built from a variable/,
  );
  assert.equal(evaluateGuard(gitRead, bash("git log $REV")), undefined, "a dynamic argument that is not the subcommand stays allowed");
});

test("a restrictive policy fails closed on a construct the parser cannot decompose", () => {
  const gitRead = guardFor({ git: "read", shell: "full" });
  const opaque = [
    "sh script.sh",
    'eval "git commit -m x"',
    "exec git commit",
    "cmd <<EOF\nbody\nEOF",
    "$CMD push",
    'bash -c "$CMD"',
    "cmd <(other)",
  ];
  const leaks = opaque.filter((command) => evaluateGuard(gitRead, bash(command))?.block !== true);
  assert.deepEqual(leaks, [], "every uninspectable construct must be blocked");
  assert.match(evaluateGuard(gitRead, bash("sh script.sh"))?.reason ?? "", /cannot enforce this policy on/);
});

test("a policy with no restrictive axis has nothing to enforce from an unparsed construct", () => {
  const permissive = guardFor({ git: "merge", filesystem: "workspace-write", network: "allowed", shell: "full" });
  assert.equal(evaluateGuard(permissive, bash('eval "echo hi"')), undefined);
  assert.equal(evaluateGuard(permissive, bash("rm -rf /tmp/x")), undefined);
});

test("a bash tool call without a string command is blocked instead of assumed safe", () => {
  const readOnly = guardFor({ filesystem: "read-only", shell: "full" });
  assert.equal(evaluateGuard(readOnly, { toolName: "bash", input: {} })?.block, true);
  assert.equal(evaluateGuard(readOnly, { toolName: "bash", input: { command: 42 } })?.block, true);
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
  assert.equal(
    evaluateGuard(inherited, { toolName: "pstack_control_cli", input: { argv: ["git", "status"] } }),
    undefined,
  );
  assert.match(
    evaluateGuard(inherited, { toolName: "pstack_control_cli", input: {} })?.reason ?? "",
    /malformed command/,
    "a call with no argv is refused instead of assumed safe",
  );
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
  const previous = process.env.PSTACK_CHILD_POLICY;
  Reflect.deleteProperty(process.env, "PSTACK_CHILD_POLICY");
  __setGuardPolicyForTests(compileTaskPolicy(undefined, "investigator"));
  try {
    const env = fakePi();
    registerPolicyGuard(env.pi as never);
    assert.equal(env.handlerCount(), 1);
    assert.equal(env.invoke({ toolName: "write", input: {} })?.block, true);
  } finally {
    if (previous !== undefined) process.env.PSTACK_CHILD_POLICY = previous;
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

function cliCall(argv: unknown) {
  return { toolName: "pstack_control_cli", input: { argv } };
}

test("a command-executing tool is gated by the shell axis, not only by its name", () => {
  for (const shell of ["none", "restricted"] as const) {
    const policy = guardFor({ shell });
    const reason = evaluateGuard(policy, cliCall(["git", "status"]))?.reason ?? "";
    assert.match(reason, new RegExp(`shell ${shell} blocks pstack_control_cli`));
  }
  const full = guardFor({ shell: "full", git: "read" });
  assert.equal(evaluateGuard(full, cliCall(["git", "status"])), undefined);
  assert.match(evaluateGuard(full, cliCall(["git", "push"]))?.reason ?? "", /git policy read blocks 'git push'/);
});

test("an argv command line is analyzed exactly as the equivalent bash command", () => {
  const readOnly = guardFor({ filesystem: "read-only", shell: "full" });
  const mutations = [
    ["git push", ["git", "push"]],
    ["git commit -m x", ["git", "commit", "-m", "x"]],
    ["rm -rf /tmp/x", ["rm", "-rf", "/tmp/x"]],
    ["sed -i s/a/b/ f", ["sed", "-i", "s/a/b/", "f"]],
    ["truncate -s0 /tmp/f", ["truncate", "-s0", "/tmp/f"]],
    ["curl -o /tmp/f https://example.com", ["curl", "-o", "/tmp/f", "https://example.com"]],
    ["npm run test:unit", ["npm", "run", "test:unit"]],
    ["node -e 1", ["node", "-e", "1"]],
    ["bash -c 'rm -rf /tmp/x'", ["bash", "-c", "rm -rf /tmp/x"]],
  ] as const;
  const mismatches = mutations.filter(
    ([command, argv]) =>
      evaluateGuard(readOnly, bash(command))?.block !== true ||
      evaluateGuard(readOnly, cliCall(argv))?.block !== true,
  );
  assert.deepEqual(mismatches, [], "both routes must reach the same verdict");

  const reads = [
    ["git status", ["git", "status"]],
    ["grep -rn nc src/", ["grep", "-rn", "nc", "src/"]],
    ["sed -n 1p f", ["sed", "-n", "1p", "f"]],
  ] as const;
  const refusals = reads.filter(
    ([command, argv]) =>
      evaluateGuard(readOnly, bash(command)) !== undefined || evaluateGuard(readOnly, cliCall(argv)) !== undefined,
  );
  assert.deepEqual(refusals, [], "both routes must leave the read path open");

  assert.equal(
    evaluateGuard(readOnly, cliCall(["echo", "pwned", ">", "/tmp/f"])),
    undefined,
    "argv carries no redirection surface, so a redirect-looking operand is a plain argument",
  );
});

test("a network-only tool is gated by the network axis before its capability grant", () => {
  const browserOnly = guardFor({ integrations: ["browser-ui"], network: "allowed" });
  assert.equal(evaluateGuard(browserOnly, { toolName: "pstack_control_ui", input: {} }), undefined);
  const noNetwork = guardFor({ integrations: ["browser-ui"], network: "none" });
  assert.match(
    evaluateGuard(noNetwork, { toolName: "pstack_control_ui", input: {} })?.reason ?? "",
    /network none blocks pstack_control_ui/,
  );
  assert.equal(evaluateGuard(noNetwork, { toolName: "read", input: {} }), undefined);
});
