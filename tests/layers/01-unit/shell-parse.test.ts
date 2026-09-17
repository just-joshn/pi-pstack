import { expect, test } from "vitest";
import { parseShellCommand, subcommandOf } from "../../../extensions/agents/shell-parse.ts";

function commandNames(command: string) {
  return parseShellCommand(command).executions.map((execution) => execution.name);
}

function argsOf(command: string, index = 0) {
  return parseShellCommand(command).executions[index].args.map((arg) => arg.value);
}

test("separators split a command line into ordered executions", () => {
  expect(commandNames("git status\ngit push origin main")).toEqual(["git", "git"]);
  expect(commandNames("cd /repo && git commit -m x || echo fail")).toEqual(["cd", "git", "echo"]);
  expect(commandNames("ls | wc -l & sleep 1 ; true")).toEqual(["ls", "wc", "sleep", "true"]);
  expect(commandNames("if [ -f x ]; then git push; fi")).toEqual(["[", "git"]);
  expect(commandNames("(cd /repo; git push)")).toEqual(["cd", "git"]);
  expect(commandNames("echo one;echo two")).toEqual(["echo", "echo"]);
});

test("quotes keep operands from being read as commands", () => {
  expect(commandNames("grep -rn nc src/")).toEqual(["grep"]);
  expect(commandNames("echo 'curl this' \"rm -rf /\"")).toEqual(["echo"]);
  expect(argsOf("echo 'a b' \"c;d\"")).toEqual(["a b", "c;d"]);
  expect(commandNames("echo a#b")).toEqual(["echo"]);
  expect(commandNames("echo hi # comment\nls")).toEqual(["echo", "ls"]);
});

test("wrappers are unwrapped to the command they run", () => {
  expect(commandNames("sudo -u root env FOO=1 git push")).toEqual(["git"]);
  expect(commandNames("xargs -n1 rm -rf")).toEqual(["rm"]);
  expect(commandNames('bash -c "git push"')).toEqual(["git"]);
  expect(commandNames("env bash -c 'git push'")).toEqual(["git"]);
  expect(commandNames("env -S 'git push'")).toEqual(["git"]);
  expect(commandNames("env --split-string='git push'")).toEqual(["git"]);
  expect(argsOf('bash -c "git push origin main"')).toEqual(["push", "origin", "main"]);
});

test("command substitutions are parsed rather than skipped", () => {
  expect(commandNames("echo $(git push)")).toEqual(["echo", "git"]);
  expect(commandNames("x=$(git push)")).toEqual(["git"]);
  expect(commandNames("echo `git push`")).toEqual(["echo", "git"]);
  expect(commandNames("echo ${x:-$(git push)}")).toEqual(["echo", "git"]);
  expect(commandNames("echo $(echo $(date))")).toEqual(["echo", "echo", "date"]);
  expect(parseShellCommand("x=$(git push)").refusals.length).toBe(0);
});

test("redirection operators are classified as writes or descriptor dups", () => {
  expect(parseShellCommand("echo hi > /tmp/f").redirects).toEqual([
    { operator: ">", target: "/tmp/f", write: true },
  ]);
  expect(parseShellCommand("echo hi >> /tmp/f").redirects).toEqual([
    { operator: ">>", target: "/tmp/f", write: true },
  ]);
  expect(parseShellCommand("cmd &> /dev/null").redirects).toEqual([
    { operator: "&>", target: "/dev/null", write: true },
  ]);
  expect(parseShellCommand("cmd 2>&1").redirects).toEqual([
    { operator: ">&", target: "1", write: false },
  ]);
  expect(parseShellCommand("cat < in.txt").redirects).toEqual([
    { operator: "<", target: "in.txt", write: false },
  ]);
});

test("unparseable constructs are refused instead of guessed", () => {
  expect(parseShellCommand("echo 'oops").refusals).toEqual(["unbalanced single quote"]);
  expect(parseShellCommand('echo "oops').refusals).toEqual(["unbalanced double quote"]);
  expect(parseShellCommand("echo $(oops").refusals).toEqual(["unbalanced command substitution `$(`"]);
  expect(parseShellCommand("cmd <<EOF\nbody\nEOF").refusals).toEqual(["here-doc or here-string"]);
  expect(parseShellCommand("cmd <(other)").refusals).toEqual([
    "process substitution, which runs an uninspected command",
  ]);
  expect(parseShellCommand('eval "git push"').refusals).toEqual(["`eval`"]);
  expect(parseShellCommand("exec git push").refusals).toEqual(["`exec`"]);
  expect(parseShellCommand("sh script.sh").refusals).toEqual(["`sh` running a script from a file or stdin"]);
  expect(parseShellCommand("$CMD push").refusals).toEqual([
    "a command name built from a variable or substitution",
  ]);
  expect(parseShellCommand('bash -c "$CMD"').refusals).toEqual(["`bash -c` with a command built from a variable"]);
});

test("a word built from an expansion is marked dynamic", () => {
  const invocation = parseShellCommand("git $SUB push").executions[0];
  expect(invocation.args).toEqual([
    { value: "$SUB", dynamic: true },
    { value: "push", dynamic: false },
  ]);
  const staticInvocation = parseShellCommand("git commit -m 'wip'").executions[0];
  expect(staticInvocation.args).toEqual([
    { value: "commit", dynamic: false },
    { value: "-m", dynamic: false },
    { value: "wip", dynamic: false },
  ]);
});

test("an ANSI-C quoted word cannot smuggle a command name past the guard", () => {
  expect(parseShellCommand("$'\\x72\\x6d' -rf /tmp/d").refusals).toEqual([
    "a command name built from a variable or substitution",
  ]);
  expect(parseShellCommand("${CMD} push").refusals).toEqual([
    "a command name built from a variable or substitution",
  ]);
});

test("subcommandOf skips value flags and reports an unresolvable subcommand", () => {
  const gitValueFlags = new Set(["-C"]);
  expect(subcommandOf(
      [
        { value: "-C", dynamic: false },
        { value: "/repo", dynamic: false },
        { value: "status", dynamic: false },
      ],
      gitValueFlags,
    )).toEqual({ sub: "status", dynamic: false });
  expect(subcommandOf(
      [
        { value: "--no-pager", dynamic: false },
        { value: "push", dynamic: false },
      ],
      gitValueFlags,
    )).toEqual({ sub: "push", dynamic: false });
  expect(subcommandOf([{ value: "$SUB", dynamic: true }], gitValueFlags)).toEqual({ dynamic: true });
  expect(subcommandOf([], gitValueFlags)).toEqual({ dynamic: false });
});
