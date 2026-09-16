/**
 * Run ids armed in this process, held as one replaceable cell.
 *
 * The arm path writes and session shutdown reads, so the set is replaced
 * wholesale: a shutdown scan cannot miss a run that armed while it iterated.
 */
export interface ArmedRunsCell {
  ids(): string[];
  arm(id: string): void;
  disarmAll(): void;
}

export function createArmedRunsCell(): ArmedRunsCell {
  let ids = new Set<string>();
  return {
    ids: () => [...ids],
    arm: (id) => {
      ids = new Set(ids).add(id);
    },
    disarmAll: () => {
      ids = new Set<string>();
    },
  };
}
