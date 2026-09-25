---
name: loop
description: >-
  Run a prompt or skill in this session on a recurring or variable interval
  (e.g. /skill:loop 5m /foo).
---
# Loop

Run `/skill:loop` on a recurring or variable interval. Use **Monitored Shell output**. In a headless run (`pi --print`, `--mode json`, or a child `Task` run), do not arm a Shell loop or timer because nothing is alive to receive its output notifications. Do the work once now and tell the user to invoke `/skill:loop` from an interactive Pi session.

## Parse

Accept `/skill:loop [interval] <prompt>`.

- Leading interval: `5m /foo`, `30s check status`, `2h run report`.
- Trailing interval: `check deploy every 5m`, `run tests every 10 minutes`.
- No interval: dynamic mode; the agent chooses the delay and may change it tick to tick.
- Empty prompt: show `Usage: /skill:loop [interval] <prompt>`.

Use intervals like `30s`, `5m`, `2h`, `1d`. Convert unit words to short units. For a calendar schedule such as "every weekday at 9am", calculate the delay to the next occurrence and use a one-shot Shell timer; Shell has no cron option.

## Monitored Shell output

Use a background Shell task to wake the agent for recurring local work.

### Fixed Schedule

```bash
while true; do
  sleep <seconds>
  echo 'AGENT_LOOP_TICK_<purpose> {"prompt":"<prompt>"}'
done
```

1. Check the conversation for an already-running matching Shell task.
2. Start one background Shell loop with `is_background: true` and `output_notification` set to `^AGENT_LOOP_TICK_<purpose>`.
3. Use a unique sentinel and a regex such as `^AGENT_LOOP_TICK_<purpose>`.
4. Check that Shell returns a `task_id` and reports the task as running.
5. Run the prompt once immediately after arming the loop.
6. The first sentinel should arrive only after the initial sleep, so startup does not double-run the prompt.
7. Track the `task_id` so the agent can stop the loop if asked, using `Task({ resume: task_id, interrupt: true })`.
8. Briefly confirm the interval, that the prompt already ran once, when the first tick will arrive, and that the loop will fire on each tick until stopped. On later ticks, give a short update of what changed. On stop, say the loop has stopped and why.

### Dynamic Schedule

The user wants the agent to self-pace. Decide what makes the next iteration worth running: a passage of time, or an observable event.

1. Run the prompt now.
2. If the next run is gated on an event (a git ref advancing, a log line matching, a file changing, a CI check completing), arm a background Shell watcher that emits the sentinel only when the event fires, with `output_notification` set to `^AGENT_LOOP_WAKE_<purpose>`. Arm once; skip on later ticks if it is still running.
3. At the end of the turn, arm a one-shot time-based wake:

```bash
sleep <seconds>
echo 'AGENT_LOOP_WAKE_<purpose> {"prompt":"<prompt>"}'
```

   Run it with `is_background: true` and `output_notification` set to `^AGENT_LOOP_WAKE_<purpose>`. With a watcher armed, this is the fallback heartbeat; choose a long delay so idle ticks are not pure overhead. Without a watcher, it is the cadence; choose when the result is worth checking again.
4. On wake, read the latest matching line, execute its `prompt`, then re-arm the next heartbeat. Re-arm the watcher only if it exited. If both an output wake and a completion notification arrive, act on the matching output once and ignore the redundant completion notice.
5. To stop, interrupt any watcher or timer with `Task({ resume: task_id, interrupt: true })`, use `Await({ task_id })` to confirm completion, and do not arm the next dynamic wake.
6. Briefly confirm that you are self-pacing, whether a watcher is the primary wake signal, the fallback delay you picked, and that the prompt already ran.

### Prompt Payload

Shell notifications include the matching output line and the task ID. They do not submit the prompt. Put the prompt beside the sentinel, preferably as JSON. On wake, read the latest matching line and act on its `prompt`; the prompt may vary by tick.

### Guidance

- Adapt loop syntax to the shell that runs the command, such as PowerShell on Windows.
- Use a unique sentinel per loop so unrelated output does not trigger the notification.
- Prefer Shell output notifications over OS cron when the agent needs to wake.
- Avoid noisy commands inside the loop.
- Do not create duplicate fixed loops or dynamic sleepers. Use one fallback timer per watched thing.
- If the user asks to stop, interrupt each tracked Shell task, await its completion so its exit notification is consumed, and do not arm another dynamic wake.
