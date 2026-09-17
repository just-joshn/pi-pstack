import { expect, test } from "vitest";
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
  expect(evaluateGuard(readOnly, { toolName: "write", input: {} })?.block).toBe(true);
  expect(evaluateGuard(readOnly, { toolName: "edit", input: {} })?.block).toBe(true);
  expect(evaluateGuard(readOnly, { toolName: "bash", input: { command: "ls" } })?.block).toBe(true);

  const shellNone = guardFor({ shell: "none" });
  expect(evaluateGuard(shellNone, bash("echo hi"))?.reason ?? "").toMatch(/shell none blocks bash/);

  const gitRead = guardFor({ git: "read", shell: "full" });
  expect(evaluateGuard(gitRead, bash("git push origin main"))?.reason ?? "").toMatch(/git policy read blocks 'git push'/);
  expect(evaluateGuard(gitRead, bash("git log --oneline -5"))).toBe(undefined);
  expect(evaluateGuard(gitRead, bash("git status --porcelain"))).toBe(undefined);

  const branchWrite = guardFor({ git: "branch-write", shell: "full" });
  expect(evaluateGuard(branchWrite, bash("git commit -m 'wip'"))).toBe(undefined);
  expect(evaluateGuard(branchWrite, bash("git checkout -b feature/x"))).toBe(undefined);
  expect(evaluateGuard(branchWrite, bash("git branch new-branch"))).toBe(undefined);
  expect(evaluateGuard(branchWrite, bash("git push origin HEAD"))?.block).toBe(true);
  expect(evaluateGuard(branchWrite, bash("git merge main"))?.block).toBe(true);

  const networkNone = guardFor({ network: "none", shell: "full" });
  expect(evaluateGuard(networkNone, bash("curl https://example.com"))?.reason ?? "").toMatch(/network none blocks 'curl'/);
  expect(evaluateGuard(networkNone, bash("npm install left-pad"))?.reason ?? "").toMatch(/network none blocks 'npm install'/);
  expect(evaluateGuard(networkNone, bash("pnpm add react"))?.reason ?? "").toMatch(/network none blocks 'pnpm add'/);
  expect(evaluateGuard(networkNone, bash("git clone https://example.com/x.git"))?.reason ?? "").toMatch(/network none blocks 'git clone'/);
  expect(evaluateGuard(networkNone, bash("gh pr create --fill"))?.reason ?? "").toMatch(/network none blocks 'gh pr create'/);
});

test("guard allows the read paths each axis leaves open", () => {
  const networkNone = guardFor({ network: "none", shell: "full" });
  expect(evaluateGuard(networkNone, bash("npm run test:unit"))).toBe(undefined);
  expect(evaluateGuard(networkNone, bash("git log --oneline"))).toBe(undefined);
  expect(evaluateGuard(networkNone, bash("gh pr view 12"))).toBe(undefined);
  expect(evaluateGuard(networkNone, bash("grep -rn nc src/")), "operands never look like commands").toBe(undefined);
  expect(evaluateGuard(networkNone, bash("echo 'curl this' > notes.txt"))).toBe(undefined);
  expect(evaluateGuard(networkNone, { toolName: "read", input: {} })).toBe(undefined);

  const full = guardFor({ git: "merge" });
  expect(evaluateGuard(full, { toolName: "edit", input: {} })).toBe(undefined);
  expect(evaluateGuard(full, bash("git push origin main"))).toBe(undefined);
  expect(evaluateGuard(full, bash("curl https://example.com"))).toBe(undefined);
});

test("guard reads git through flags and every command segment", () => {
  const gitRead = guardFor({ git: "read", shell: "full" });
  expect(evaluateGuard(gitRead, bash("git -C /repo push origin main"))?.reason ?? "").toMatch(/blocks 'git push'/);
  expect(evaluateGuard(gitRead, bash("cd /repo && git commit -m 'x'"))?.reason ?? "").toMatch(/blocks 'git commit'/);
  expect(evaluateGuard(gitRead, bash("sudo git reset --hard HEAD~1"))?.reason ?? "").toMatch(/blocks 'git reset'/);
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
  expect(leaks, "every mutating command must be blocked").toEqual([]);

  expect(evaluateGuard(readOnly, bash("ls -la"))).toBe(undefined);
  expect(evaluateGuard(readOnly, bash("grep -rn pattern src/"))).toBe(undefined);
  expect(evaluateGuard(readOnly, bash("sed -n 1p file")), "sed without -i only reads").toBe(undefined);
  expect(evaluateGuard(readOnly, bash("git log --oneline -5"))).toBe(undefined);
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
  expect(leaks, "every hidden push must be blocked").toEqual([]);
});

test("git read refuses a subcommand it cannot resolve instead of allowing it", () => {
  const gitRead = guardFor({ git: "read", shell: "full" });
  expect(evaluateGuard(gitRead, bash("git $SUB origin main"))?.reason ?? "").toMatch(/cannot verify a git subcommand built from a variable/);
  expect(evaluateGuard(gitRead, bash("git log $REV")), "a dynamic argument that is not the subcommand stays allowed").toBe(undefined);
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
  expect(leaks, "every uninspectable construct must be blocked").toEqual([]);
  expect(evaluateGuard(gitRead, bash("sh script.sh"))?.reason ?? "").toMatch(/cannot enforce this policy on/);
});

test("a policy with no restrictive axis has nothing to enforce from an unparsed construct", () => {
  const permissive = guardFor({ git: "merge", filesystem: "workspace-write", network: "allowed", shell: "full" });
  expect(evaluateGuard(permissive, bash('eval "echo hi"'))).toBe(undefined);
  expect(evaluateGuard(permissive, bash("rm -rf /tmp/x"))).toBe(undefined);
});

test("a bash tool call without a string command is blocked instead of assumed safe", () => {
  const readOnly = guardFor({ filesystem: "read-only", shell: "full" });
  expect(evaluateGuard(readOnly, { toolName: "bash", input: {} })?.block).toBe(true);
  expect(evaluateGuard(readOnly, { toolName: "bash", input: { command: 42 } })?.block).toBe(true);
});

test("integrations grant blocks a non-granted capability tool and allows a granted one", () => {
  const browserOnly = guardFor({ integrations: ["browser-ui"] });
  expect(evaluateGuard(browserOnly, { toolName: "pstack_control_ui", input: {} })).toBe(undefined);
  expect(evaluateGuard(browserOnly, { toolName: "pstack_control_cli", input: {} })?.reason ?? "").toMatch(/excludes cli-tui/);
  expect(evaluateGuard(browserOnly, { toolName: "read", input: {} })).toBe(undefined);

  const none = guardFor({ integrations: "none" });
  expect(evaluateGuard(none, { toolName: "pstack_control_ui", input: {} })?.reason ?? "").toMatch(/integrations none excludes browser-ui/);

  const inherited = guardFor({ integrations: "inherit" });
  expect(evaluateGuard(inherited, { toolName: "pstack_control_cli", input: { argv: ["git", "status"] } })).toBe(undefined);
  expect(evaluateGuard(inherited, { toolName: "pstack_control_cli", input: {} })?.reason ?? "", "a call with no argv is refused instead of assumed safe").toMatch(/malformed command/);
});

test("malformed PSTACK_CHILD_POLICY blocks writes instead of silently allowing them", () => {
  const previous = process.env.PSTACK_CHILD_POLICY;
  try {
    for (const raw of ["{not json", JSON.stringify({ filesystem: "readwrite" })]) {
      process.env.PSTACK_CHILD_POLICY = raw;
      const env = fakePi();
      registerPolicyGuard(env.pi as never);
      expect(env.handlerCount()).toBe(1);
      const blocked = env.invoke({ toolName: "write", input: {} });
      expect(blocked?.block, `expected a block for ${raw}`).toBe(true);
      expect(blocked?.reason ?? "").toMatch(/PSTACK_CHILD_POLICY/);
      expect(env.invoke({ toolName: "edit", input: {} })?.block).toBe(true);
      expect(env.invoke({ toolName: "bash", input: { command: "rm -rf x" } })?.block).toBe(true);
      expect(env.invoke({ toolName: "read", input: {} }), "reads cannot mutate").toBe(undefined);
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
    expect(env.handlerCount()).toBe(0);
    expect(env.invoke({ toolName: "write", input: {} })).toBe(undefined);
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
    expect(env.invoke({ toolName: "write", input: {} })).toBe(undefined);
    expect(env.invoke({ toolName: "bash", input: { command: "git push" } })?.reason ?? "").toMatch(/git policy read/);
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
    expect(env.handlerCount()).toBe(1);
    expect(env.invoke({ toolName: "write", input: {} })?.block).toBe(true);
  } finally {
    if (previous !== undefined) process.env.PSTACK_CHILD_POLICY = previous;
    __setGuardPolicyForTests(null);
  }
});

test("parseGuardPolicy reports schema failures without throwing", () => {
  expect(parseGuardPolicy("not json").policy).toBe(undefined);
  expect(parseGuardPolicy("not json").blockReason ?? "").toMatch(/not valid JSON/);
  expect(parseGuardPolicy(JSON.stringify({ filesystem: "readwrite" })).policy).toBe(undefined);
  expect(parseGuardPolicy(JSON.stringify({ filesystem: "readwrite" })).blockReason ?? "").toMatch(/failed policy validation/);
  const good = parseGuardPolicy(JSON.stringify(compileTaskPolicy(undefined, "comment-sicko")));
  expect(good.blockReason).toBe(undefined);
  expect(good.policy?.integrations).toBe("none");
});

function cliCall(argv: unknown) {
  return { toolName: "pstack_control_cli", input: { argv } };
}

test("a command-executing tool is gated by the shell axis, not only by its name", () => {
  for (const shell of ["none", "restricted"] as const) {
    const policy = guardFor({ shell });
    const reason = evaluateGuard(policy, cliCall(["git", "status"]))?.reason ?? "";
    expect(reason).toMatch(new RegExp(`shell ${shell} blocks pstack_control_cli`));
  }
  const full = guardFor({ shell: "full", git: "read" });
  expect(evaluateGuard(full, cliCall(["git", "status"]))).toBe(undefined);
  expect(evaluateGuard(full, cliCall(["git", "push"]))?.reason ?? "").toMatch(/git policy read blocks 'git push'/);
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
  expect(mismatches, "both routes must reach the same verdict").toEqual([]);

  const reads = [
    ["git status", ["git", "status"]],
    ["grep -rn nc src/", ["grep", "-rn", "nc", "src/"]],
    ["sed -n 1p f", ["sed", "-n", "1p", "f"]],
  ] as const;
  const refusals = reads.filter(
    ([command, argv]) =>
      evaluateGuard(readOnly, bash(command)) !== undefined || evaluateGuard(readOnly, cliCall(argv)) !== undefined,
  );
  expect(refusals, "both routes must leave the read path open").toEqual([]);

  expect(evaluateGuard(readOnly, cliCall(["echo", "pwned", ">", "/tmp/f"])), "argv carries no redirection surface, so a redirect-looking operand is a plain argument").toBe(undefined);
});

test("a network-only tool is gated by the network axis before its capability grant", () => {
  const browserOnly = guardFor({ integrations: ["browser-ui"], network: "allowed" });
  expect(evaluateGuard(browserOnly, { toolName: "pstack_control_ui", input: {} })).toBe(undefined);
  const noNetwork = guardFor({ integrations: ["browser-ui"], network: "none" });
  expect(evaluateGuard(noNetwork, { toolName: "pstack_control_ui", input: {} })?.reason ?? "").toMatch(/network none blocks pstack_control_ui/);
  expect(evaluateGuard(noNetwork, { toolName: "read", input: {} })).toBe(undefined);
});
