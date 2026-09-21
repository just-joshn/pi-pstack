# benny

benny gives you two scheduled agent runs for slack issue reports. one triages each report. the other reproduces confirmed bugs and may prepare a small draft fix. on pi, schedule each run with cron (or any scheduler) piping its template prompt into `pi -p` in the target repository. in cursor, they map to live cursor automations.

the files in this directory are dormant setup and automation sources. they do not appear as slash skills.

## set it up

1. point the agent at [`FOR_AGENTS.md`](./FOR_AGENTS.md) and name the target repository.
2. let setup merge this whole directory into the target at `.pi/automations/benny/`. it must preserve destination-only files and review conflicts instead of overwriting local edits.
3. let setup enable pstack in the target repository's `.pi/settings.json` for shared dependencies:

```json
{
	"packages": [
		"/absolute/path/to/pstack"
	]
}
```

4. keep user-owned configuration outside the copied pack, for example in `.pi/benny/`. adapt [`configuration.example.yaml`](./templates/configuration.example.yaml) and [`feature-map.example.md`](./skills/reproduce-and-fix-issues/references/feature-map.example.md).
5. commit `.pi/settings.json`, `.pi/automations/benny/`, and any secret-free configuration before enabling either automation.
6. review each new schedule or update existing ones in your scheduler. then send a harmless test report and verify every source-channel post stays in the original thread.
