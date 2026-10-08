/**
 * Plans the stored positions to write when the user moves notes. Sending and storing a new position for every listed note made
 * one drag cost O(account) locally, on the server and in every other device's sync; the plan keeps the longest run of notes that
 * is already in the requested order on its stored positions and only gives the others new ones, between their kept neighbours.
 *
 * Pinned and other notes are ordered independently, so only positions within a group matter. The same algorithm exists in the
 * Android client; test-fixtures/note-order-plan.json holds the cases both implementations must reproduce exactly.
 */
export interface NoteOrderPlanInput {
  /** Note ids in the order the user wants, no duplicates. */
  desired: number[];
  /** Stored position of each id (descending positions are displayed first). */
  current: ReadonlyMap<number, number>;
  pinned?: ReadonlySet<number>;
}

/** Closest two planned positions may be before they could no longer be told apart. */
export const MIN_POSITION_GAP = 1e-3;

// Longest strictly decreasing run of stored positions along the requested order.
function keptIndexes(values: number[]): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    const key = -value;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (-values[tails[middle]] < key) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  });
  const kept = new Set<number>();
  for (let index = tails[tails.length - 1]; index !== undefined && index >= 0; index = previous[index]) kept.add(index);
  return kept;
}

function planGroup(desired: number[], current: ReadonlyMap<number, number>): Array<[number, number]> {
  if (!desired.length) return [];
  const values = desired.map(id => current.get(id) ?? 0);
  const kept = keptIndexes(values);
  if (kept.size === desired.length) return [];
  const plan: Array<[number, number]> = [];
  let index = 0;
  while (index < desired.length) {
    if (kept.has(index)) { index += 1; continue; }
    const start = index;
    while (index < desired.length && !kept.has(index)) index += 1;
    const count = index - start;
    const above = start > 0 ? values[start - 1] : undefined;
    const below = index < desired.length ? values[index] : undefined;
    const run: number[] = [];
    for (let step = 0; step < count; step += 1) {
      if (above !== undefined && below !== undefined) run.push(above - (above - below) * (step + 1) / (count + 1));
      else if (above !== undefined) run.push(above - (step + 1));
      else run.push((below as number) + (count - step));
    }
    const fits = run.every((candidate, position) => Number.isFinite(candidate) &&
      (position === 0 || run[position - 1] - candidate >= MIN_POSITION_GAP) &&
      (above === undefined || above - candidate >= MIN_POSITION_GAP) &&
      (below === undefined || candidate - below >= MIN_POSITION_GAP));
    if (!fits) {
      // No room between two neighbours: renumber the whole group above everything it holds now.
      const top = Math.max(...values);
      return desired.map((id, position): [number, number] => [id, top + (desired.length - position)]);
    }
    run.forEach((value, position) => plan.push([desired[start + position], value]));
  }
  return plan;
}

/** The [id, position] pairs to store for the requested order; empty when the order already holds. */
export function planNoteOrder({ desired, current, pinned = new Set<number>() }: NoteOrderPlanInput): Array<[number, number]> {
  const groups: number[][] = [[], []];
  for (const id of desired) groups[pinned.has(id) ? 0 : 1].push(id);
  return groups.flatMap(group => planGroup(group, current));
}
