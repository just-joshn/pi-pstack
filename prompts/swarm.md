---
name: swarm
description: Swarm parallel workers
---

/skill:swarm

Pi: `pstack_swarm` = intentional sync gather (EQUIVALENT local-gather). For background fan-out + drain use N× `pstack_spawn` (background omit/default) + `pstack_jobs`. Concurrency default 8.
