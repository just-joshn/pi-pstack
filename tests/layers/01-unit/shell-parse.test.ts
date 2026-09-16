import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShellCommand, subcommandOf } from "../../../extensions/agents/shell-parse.ts";

function commandNames(command: string) {
  return parseShellCommand(command).executions.map((execution) => execution.name);
}

function argsOf(command: string, index = 0) {
  return parseShellCommand(command).executions[index].args.map((arg) => arg.value);
}

test("separators split a command line into ordered executions", () => {
  assert.deepEqual(commandNames("git status\ngit push origin main"), ["git", "git"]);
  assert.deepEqual(commandNames("cd /repo && git commit -m x || echo fail"), ["cd", "git", "echo"]);
  assert.deepEqual(commandNames("ls | wc -l & sleep 1 ; true"), ["ls", "wc", "sleep", "true"]);
  assert.deepEqual(commandNames("if [ -f x ]; then git push; fi"), ["[", "git"]);
  assert.deepEqual(commandNames("(cd /repo; git push)"), ["cd", "git"]);
  assert.deepEqual(commandNames("echo one;echo two"), ["echo", "echo"]);
});

test("quotes keep operands from being read as commands", () => {
  assert.deepEqual(commandNames("grep -rn nc src/"), ["grep"]);
  assert.deepEqual(commandNames("echo 'curl this' \"rm -rf /\""), ["echo"]);
  assert.deepEqual(argsOf("echo 'a b' \"c;d\""), ["a b", "c;d"]);
  assert.deepEqual(commandNames("echo a#b"), ["echo"]);
  assert.deepEqual(commandNames("echo hi # comment\nls"), ["echo", "ls"]);
});

test("wrappers are unwrapped to the command they run", () => {
  assert.deepEqual(commandNames("sudo -u root env FOO=1 git push"), ["git"]);
  assert.deepEqual(commandNames("xargs -n1 rm -rf"), ["rm"]);
  assert.deepEqual(commandNames('bash -c "git push"'), ["git"]);
  assert.deepEqual(commandNames("env bash -c 'git push'"), ["git"]);
  assert.deepEqual(commandNames("env -S 'git push'"), ["git"]);
  assert.deepEqual(commandNames("env --split-string='git push'"), ["git"]);
  assert.deepEqual(argsOf('bash -c "git push origin main"'), ["push", "origin", "main"]);
});

test("command substitutions are parsed rather than skipped", () => {
  assert.deepEqual(commandNames("echo $(git push)"), ["echo", "git"]);
  assert.deepEqual(commandNames("x=$(git push)"), ["git"]);
  assert.deepEqual(commandNames("echo `git push`"), ["echo", "git"]);
  assert.deepEqual(commandNames("echo ${x:-$(git push)}"), ["echo", "git"]);
  assert.deepEqual(commandNames("echo $(echo $(date))"), ["echo", "echo", "date"]);
  assert.equal(parseShellCommand("x=$(git push)").refusals.length, 0);
});

test("redirection operators are classified as writes or descriptor dups", () => {
  assert.deepEqual(parseShellCommand("echo hi > /tmp/f").redirects, [
    { operator: ">", target: "/tmp/f", write: true },
  ]);
  assert.deepEqual(parseShellCommand("echo hi >> /tmp/f").redirects, [
    { operator: ">>", target: "/tmp/f", write: true },
  ]);
  assert.deepEqual(parseShellCommand("cmd &> /dev/null").redirects, [
    { operator: "&>", target: "/dev/null", write: true },
  ]);
  assert.deepEqual(parseShellCommand("cmd 2>&1").redirects, [
    { operator: ">&", target: "1", write: false },
  ]);
  assert.deepEqual(parseShellCommand("cat < in.txt").redirects, [
    { operator: "<", target: "in.txt", write: false },
  ]);
});

test("unparseable constructs are refused instead of guessed", () => {
  assert.deepEqual(parseShellCommand("echo 'oops").refusals, ["unbalanced single quote"]);
  assert.deepEqual(parseShellCommand('echo "oops').refusals, ["unbalanced double quote"]);
  assert.deepEqual(parseShellCommand("echo $(oops").refusals, ["unbalanced command substitution `$(`"]);
  assert.deepEqual(parseShellCommand("cmd <<EOF\nbody\nEOF").refusals, ["here-doc or here-string"]);
  assert.deepEqual(parseShellCommand("cmd <(other)").refusals, [
    "process substitution, which runs an uninspected command",
  ]);
  assert.deepEqual(parseShellCommand('eval "git push"').refusals, ["`eval`"]);
  assert.deepEqual(parseShellCommand("exec git push").refusals, ["`exec`"]);
  assert.deepEqual(parseShellCommand("sh script.sh").refusals, ["`sh` running a script from a file or stdin"]);
  assert.deepEqual(parseShellCommand("$CMD push").refusals, [
    "a command name built from a variable or substitution",
  ]);
  assert.deepEqual(parseShellCommand('bash -c "$CMD"').refusals, ["`bash -c` with a command built from a variable"]);
});

test("a word built from an expansion is marked dynamic", () => {
  const invocation = parseShellCommand("git $SUB push").executions[0];
  assert.deepEqual(invocation.args, [
    { value: "$SUB", dynamic: true },
    { value: "push", dynamic: false },
  ]);
  const staticInvocation = parseShellCommand("git commit -m 'wip'").executions[0];
  assert.deepEqual(staticInvocation.args, [
    { value: "commit", dynamic: false },
    { value: "-m", dynamic: false },
    { value: "wip", dynamic: false },
  ]);
});

test("an ANSI-C quoted word cannot smuggle a command name past the guard", () => {
  assert.deepEqual(parseShellCommand("$'\\x72\\x6d' -rf /tmp/d").refusals, [
    "a command name built from a variable or substitution",
  ]);
  assert.deepEqual(parseShellCommand("${CMD} push").refusals, [
    "a command name built from a variable or substitution",
  ]);
});

test("subcommandOf skips value flags and reports an unresolvable subcommand", () => {
  const gitValueFlags = new Set(["-C"]);
  assert.deepEqual(
    subcommandOf(
      [
        { value: "-C", dynamic: false },
        { value: "/repo", dynamic: false },
        { value: "status", dynamic: false },
      ],
      gitValueFlags,
    ),
    { sub: "status", dynamic: false },
  );
  assert.deepEqual(
    subcommandOf(
      [
        { value: "--no-pager", dynamic: false },
        { value: "push", dynamic: false },
      ],
      gitValueFlags,
    ),
    { sub: "push", dynamic: false },
  );
  assert.deepEqual(subcommandOf([{ value: "$SUB", dynamic: true }], gitValueFlags), { dynamic: true });
  assert.deepEqual(subcommandOf([], gitValueFlags), { dynamic: false });
});
