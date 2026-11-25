export const jobKinds = ["custom", "benny-triage", "benny-repro"] as const;
export type JobKind = (typeof jobKinds)[number];
export type BennyKind = Exclude<JobKind, "custom">;
export const isJobKind = (value: unknown): value is JobKind =>
  jobKinds.some((kind) => kind === value);
