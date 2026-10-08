/** Bullet lists in a note body can be nested this many levels deep. Keep in sync with MAX_BULLET_LEVELS on Android. */
export const MAX_BODY_LIST_LEVELS = 4;

type NodeLike = { tagName?: string; parentElement?: NodeLike | null };

/** Number of enclosing lists between `node` and `root` (0 = not in a list). */
export function listDepth(node: NodeLike | null | undefined, root: NodeLike | null | undefined): number {
  let depth = 0;
  for (let el = node ?? null; el && el !== root; el = el.parentElement ?? null) {
    if (el.tagName === 'UL' || el.tagName === 'OL') depth++;
  }
  return depth;
}

export const canIndentBodyList = (depth: number) => depth > 0 && depth < MAX_BODY_LIST_LEVELS;
export const canOutdentBodyList = (depth: number) => depth > 0;
