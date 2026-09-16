/**
 * Registry of live background children, held as one replaceable cell.
 *
 * The job records and their abort controllers are reachable from the spawn
 * path, the cancel path, and session shutdown. Keeping both maps in one cell
 * and replacing them wholesale on every write means no reader can observe a
 * half-applied spawn: a job recorded without its controller, or a controller
 * no longer reachable by the id that owns it.
 */
export interface JobRegistryCell<Job extends { id: string }> {
  jobs(): Job[];
  job(id: string): Job | undefined;
  putJob(job: Job): void;
  controller(id: string): AbortController | undefined;
  controllerIds(): string[];
  putController(id: string, controller: AbortController): void;
  dropController(id: string): void;
  reset(): void;
}

export function createJobRegistryCell<Job extends { id: string }>(): JobRegistryCell<Job> {
  let jobs = new Map<string, Job>();
  let controllers = new Map<string, AbortController>();
  return {
    jobs: () => [...jobs.values()],
    job: (id) => jobs.get(id),
    putJob: (job) => {
      jobs = new Map(jobs).set(job.id, job);
    },
    controller: (id) => controllers.get(id),
    controllerIds: () => [...controllers.keys()],
    putController: (id, controller) => {
      controllers = new Map(controllers).set(id, controller);
    },
    dropController: (id) => {
      const remaining = new Map(controllers);
      remaining.delete(id);
      controllers = remaining;
    },
    reset: () => {
      jobs = new Map();
      controllers = new Map();
    },
  };
}
