/**
 * SEC-01..SEC-05: policy-guard enforcement boundary. Every predicate calls the
 * real evaluateGuard export, or reads the guard source, so a leak is observed
 * rather than asserted from documentation.
 */
import { readFileSync } from "node:fs";
import { READ_ONLY_POLICY, fail, importExtension, pass, repoPath, verdict } from "./harness.mjs";

const GUARD_MODULE = "extensions/agents/policy-guard.ts";

const FILESYSTEM_WRITE_COMMANDS = Object.freeze([
  "echo pwned > /tmp/f",
  "echo x >> /tmp/f",
  "rm -rf /tmp/d",
  "mv a b",
  "cp a b",
  "dd if=/dev/zero of=/tmp/f",
  "truncate -s0 /tmp/f",
  "sed -i s/a/b/ f",
  "tee /tmp/f",
  "mkdir /tmp/d",
  "touch /tmp/f",
  "chmod 777 f",
  "ln -s a b",
  "git checkout -- .",
]);

const NEWLINE_PUSH = "git status\ngit push origin main";

const SHELL_WRAPPED_PUSH = Object.freeze([
  'bash -c "git push origin main"',
  "sh -c 'git push'",
  'zsh -c "git push"',
  'env bash -c "git push"',
]);

const SUBSTITUTED_PUSH = Object.freeze([
  "$(git push origin main)",
  "`git push origin main`",
  "x=$(git push)",
]);

const SECURITY_CONST_NAME = /^(?:const|let|var)\s+([A-Z0-9_]*(?:_VERBS|_BLOCKED|_COMMANDS|_PREFIXES))\b/;

async function loadGuard() {
  const module = await importExtension(GUARD_MODULE);
  if (typeof module.evaluateGuard !== "function") {
    throw new Error(`${GUARD_MODULE} does not export evaluateGuard`);
  }
  return module.evaluateGuard;
}

function blocksAll(evaluateGuard, commands, policy = READ_ONLY_POLICY) {
  return commands.filter(
    (command) => evaluateGuard(policy, { toolName: "bash", input: { command } })?.block !== true,
  );
}

function leakDetail(label, leaks, total) {
  return `${leaks.length}/${total} ${label} reach bash unblocked: ${leaks.map((c) => JSON.stringify(c)).join(", ")}`;
}

async function secFilesystemBash() {
  const evaluateGuard = await loadGuard();
  const leaks = blocksAll(evaluateGuard, FILESYSTEM_WRITE_COMMANDS);
  return verdict(
    leaks.length === 0,
    `all ${FILESYSTEM_WRITE_COMMANDS.length} mutating shell commands blocked under filesystem read-only`,
    leakDetail("mutating shell commands", leaks, FILESYSTEM_WRITE_COMMANDS.length),
  );
}

async function secNewlinePush() {
  const evaluateGuard = await loadGuard();
  const decision = evaluateGuard(READ_ONLY_POLICY, {
    toolName: "bash",
    input: { command: NEWLINE_PUSH },
  });
  return verdict(
    decision?.block === true,
    "newline-joined 'git push' is blocked under git read",
    "newline is not a command separator, so 'git status\\ngit push origin main' runs unblocked under git read",
  );
}

async function secShellWrapperPush() {
  const evaluateGuard = await loadGuard();
  const leaks = blocksAll(evaluateGuard, SHELL_WRAPPED_PUSH);
  return verdict(
    leaks.length === 0,
    "every shell-wrapper form of 'git push' is blocked under git read",
    leakDetail("shell-wrapped pushes", leaks, SHELL_WRAPPED_PUSH.length),
  );
}

async function secSubstitutionPush() {
  const evaluateGuard = await loadGuard();
  const leaks = blocksAll(evaluateGuard, SUBSTITUTED_PUSH);
  return verdict(
    leaks.length === 0,
    "command-substitution forms of 'git push' are blocked under git read",
    leakDetail("command-substitution pushes", leaks, SUBSTITUTED_PUSH.length),
  );
}

function securityConstNames(source) {
  return source
    .split("\n")
    .flatMap((line) => {
      const match = SECURITY_CONST_NAME.exec(line.trim());
      return match ? [match[1]] : [];
    });
}

function referenceCount(source, name) {
  const matches = source.match(new RegExp(`\\b${name}\\b`, "g"));
  return matches ? matches.length : 0;
}

async function secNoDeadSecurityConfig() {
  const source = readFileSync(repoPath(GUARD_MODULE), "utf8");
  const names = securityConstNames(source);
  if (names.length === 0) return fail(`${GUARD_MODULE} declares no *_VERBS/_BLOCKED/_COMMANDS/_PREFIXES const`);
  const dead = names.filter((name) => referenceCount(source, name) < 2);
  if (dead.length === 0) {
    return pass(`all ${names.length} security tables in ${GUARD_MODULE} are declared and used`);
  }
  return fail(`declared but never used in ${GUARD_MODULE}: ${dead.join(", ")} (of ${names.length} tables)`);
}

export const SEC_GUARD_PREDICATES = Object.freeze([
  {
    id: "SEC-01",
    description: "filesystem read-only blocks mutating bash commands, not just the write/edit tools",
    run: secFilesystemBash,
  },
  {
    id: "SEC-02",
    description: "git read blocks a newline-joined 'git push'",
    run: secNewlinePush,
  },
  {
    id: "SEC-03",
    description: "git read blocks 'git push' wrapped in bash/sh/zsh/env -c",
    run: secShellWrapperPush,
  },
  {
    id: "SEC-04",
    description: "git read blocks 'git push' hidden in command substitution",
    run: secSubstitutionPush,
  },
  {
    id: "SEC-05",
    description: "every security table in policy-guard.ts is referenced, not dead config",
    run: secNoDeadSecurityConfig,
  },
]);
