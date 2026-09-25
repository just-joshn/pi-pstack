# U6: user-perspective end-to-end test of the pi-pstack package in a real Pi TUI

You are a tester acting as a user. Drive a real interactive Pi in tmux and judge only what a user sees plus the files Pi writes. Build your harness with the **control-cli** skill (`~/.pi/agent/skills/control-cli/SKILL.md`). Do not fix anything. Report.

## Setup (exactly)

- Package under test: commit `6db1587` of `/Users/josh-desktop/.pi/agent/pstack/pi-pstack`. Make a clean copy: `git -C <repo> archive 6db1587 | tar -x -C $PKG` into `PKG=$(mktemp -d)`, then `cd $PKG && npm ci --omit=dev`.
- Isolated Pi config dir: `AGENT=$(mktemp -d)`; copy only `~/.pi/agent/auth.json` into it; write `$AGENT/settings.json` from `jq 'del(.subagents,.packages)' ~/.pi/agent/settings.json`; `PI_CODING_AGENT_DIR=$AGENT pi install $PKG`. Scratch project: a `git init` dir with a few files.
- Run every Pi with all `PI_*` variables unset except `PI_CODING_AGENT_DIR=$AGENT`. Use the settings' default model; for Task calls you ask Pi to make, ask for `model: "openai-codex/gpt-6-luna:low"` to keep runs short.
- Evidence goes under `/Users/josh-desktop/.pi/agent/pstack/pi-pstack/parity/evidence/u6/<case>/` (screen captures, copied session and run files). Final report: `.../parity/evidence/u6/report.md`.
- Forbidden: anything on GitHub, any change under `~/.pi/agent` outside `parity/evidence/u6/`, killing processes you did not start, editing the package. Time box: 2 hours.

## Cases (what you type, what you check)

a. Start Pi. Check: no startup warnings or resource diagnostics; the `/` menu lists pstack skills (`/skill:how`, `/skill:poteto-mode`, ...) and the commands `/goal`, `/poteto`, `/todos`.
b. `/skill:poteto-mode` then ask a one-line question about the scratch repo. Check: footer shows `👑 poteto`; the next turn still carries the reminder (session JSONL); `/poteto off` clears the footer.
c. Ask Pi to run one foreground Task (`generalPurpose`) and one background Task, then wait for the background one with SubagentAwait. Check: both results shown; exactly one completion notice for the background run in the session JSONL.
d. Ask Pi to start a background Shell that prints `READY_X` after 20 s with `output_notification: "^READY_X"`. Check: Pi wakes on the match without you typing; Await on it returns.
e. `/skill:loop 1m echo tick`. Check: one Shell loop armed with a sentinel, the prompt ran once, the first tick arrives after about a minute; then ask Pi to stop the loop and confirm it stopped (no runner left: `ps`).
f. Ask Pi to create a goal for a trivial task with CreateGoal, then `/goal`. Check: the goal shows; UpdateGoal completes it.
g. Ask Pi to ask you a multiple-choice question with a recommended option (questionnaire). Check: the recommended option is shown first and labelled; your answer reaches the model.
h. Ask Pi to plan a 3-step task with the todo tool; then `/todos`. Check: items listed; statuses update.
i. Guards: (1) ask Pi to have a `generalPurpose` Task read `$PKG/skills/poteto-mode/playbooks/investigation.md`; check the child is blocked with the guard message. (2) Without saying you want to edit a skill, ask Pi to append a line to `$PKG/skills/how/SKILL.md`; check it is blocked. (3) Then say explicitly you want that skill file edited; check it is allowed (revert the edit after).
j. `/skill:how how does <something in the scratch repo> work?` Check: the explainer Task request uses `pstack-reader` with tools `read, grep, find, ls` (run dir `request.json`), and no child reads a poteto-mode playbook.
k. `/skill:setup-pstack`, pick any budget. Check: `$AGENT/AGENTS.md` gains the pstack block (with the absolute poteto-mode SKILL.md path in the reminder line, pointing inside `$PKG`), and `$AGENT/extensions/pstack-agents.json` holds `{ "modelScope": {...} }`. Then ask for a Task with a model outside the allow list; check it is refused with a clear error.
l. Restart: ask for a background Task running `sleep 90` then replying DONE; once running, `/quit`; start `pi -c` in the same project. Check: the run completed and exactly one completion notice arrives after resume.
m. Headless: `pi --print '/skill:loop 1m x'` (same env). Check: returns within 2 minutes, arms nothing, leaves no Shell process.
n. Poteto agent: ask for a Task with `subagent_type: "poteto-agent"` and an attachment, prompt "Reply with the absolute path of the poteto-mode SKILL.md you were told to read". Check: the reply is inside `$PKG/skills/poteto-mode/SKILL.md`.

## Report

`report.md`: a table `case | typed | expected | observed (evidence path) | PASS/ISSUE/BLOCKED`, then findings ranked by severity, each with evidence. Your final reply: the report path, the tally, and the findings list.
