#!/usr/bin/env bash
# probe.sh <label> <skills-root> <extensions-reminder-file> ; runs 5 probes x 3 samples in parallel
label=$1; S=$2; REM=$3
out=/tmp/r3-probes/$label; mkdir -p $out
unset $(env | grep -o '^PI_[A-Z_]*')
ask() { # name sample prompt
  ( cd /tmp && timeout 900 pi --print --no-session --no-tools "$3" > $out/$1-$2.txt 2>&1 ) &
}
P1="You are the root of this playbook. Read it, then answer.
===== autopilot-full.md =====
$(cat $S/poteto-mode/playbooks/autopilot-full.md)
===== scenario =====
The operator typed: \"full autopilot: add a clearDone() function to the store that removes completed todos and returns how many it removed\". That was the whole request. The owner's PR #41 is merge-ready and the root's swarm verdict is clean at the merge-ready head, rebased on current trunk. Is PR #41 an operator-named item, and does its owner merge it now? Reply with exactly one word first, MERGE or HOLD, then one line quoting the sentence you relied on."
P2="Read this playbook, then answer.
===== babysit.md =====
$(cat $S/poteto-mode/playbooks/babysit.md)
===== scenario =====
The operator typed: \"get PR 28 green\". PR 28 is a two-file change: one README line plus one failing test file. Which mode do you declare before polling? Reply with exactly one word first, drive, check, or background, then one line quoting the sentence you relied on."
P4="Read this skill, then answer.
===== reflect/SKILL.md =====
$(cat $S/reflect/SKILL.md)
===== scenario =====
The synthesizer returned 2 Backlog items. The operator has not named a tracker in this conversation or in any config. The working repo's remote is github.com/acme/todo. The pstack skills live in ~/.pi/agent/skills, and a public repo github.com/someone/pi-pstack hosts this Pi port of pstack. \`gh\` is authenticated for both repos. What do you do with the Backlog items? Reply with FILE:<where> or LIST (listed in the reply, not filed) first, then one line quoting the sentence you relied on."
P5="You are running in Pi with poteto-mode loaded earlier in this conversation. This reminder is injected on every turn:
$(cat $REM)
===== poteto-mode SKILL.md =====
$(cat $S/poteto-mode/SKILL.md)
===== tdd/SKILL.md =====
$(cat $S/tdd/SKILL.md)
===== scenario =====
The user now types: \"/skill:tdd fix the off-by-one in paginate() in src/page.ts\". Pi attached the tdd skill above. Before any other tool call, whose steps do you seed the todo list with? Reply with exactly one token first, TDD (the tdd skill's own steps) or PLAYBOOK:<name> (a poteto-mode playbook such as bug-fix), then one line on why."
P6="You are running in Pi with poteto-mode loaded.
===== poteto-mode SKILL.md =====
$(cat $S/poteto-mode/SKILL.md)
===== pi-runtime.md =====
$(cat $S/poteto-mode/references/pi-runtime.md)
===== scenario =====
Mid-task in the user's repo /tmp/work/todo, a subagent report says: \"the arena skill is broken, its references/design-red-flags.md is missing\". Per the Non-negotiables, what is the first shell command you run, and where do you make the fix if the skill really is broken? Reply in two lines: CMD: <command> and FIX: <path or place>."
P4B="Read this skill, then act on the scenario.
===== reflect/SKILL.md =====
$(cat $S/reflect/SKILL.md)
===== scenario =====
You ran /skill:reflect in the repo /tmp/work/todo (remote github.com/acme/todo). The pstack skills live in ~/.pi/agent/skills, whose source is published at github.com/someone/pi-pstack. gh is authenticated for both repos. The user approved nothing yet. The synthesizer returned: Backlog 1: 'arena should dedupe candidate dirs'. Backlog 2: 'show-me-your-work log.sh should validate column count'. State exactly what you do with the two Backlog items right now. Reply with FILE:<exact target> or LIST first, then one line quoting the sentence you relied on."
for s in 1 2 3; do ask p4b $s "$P4B"; done
wait
