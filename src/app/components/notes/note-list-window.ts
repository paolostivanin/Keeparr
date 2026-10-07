export interface NoteListWindow {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
  totalHeight: number;
}

/** Variable-height list window backed by a Fenwick tree for logarithmic offsets. */
export class NoteListWindowModel<T> {
  private keys: string[] = [];
  private heights: number[] = [];
  private tree: number[] = [];
  private indexByKey = new Map<string, number>();
  private total = 0;

  setItems(items: readonly T[], keyOf: (item: T) => string, estimate: (item: T) => number) {
    const nextKeys = items.map(keyOf);
    if (nextKeys.length === this.keys.length && nextKeys.every((key, index) => key === this.keys[index])) return false;
    const measured = new Map(this.keys.map((key, index) => [key, this.heights[index]]));
    this.keys = nextKeys;
    this.heights = items.map((item, index) => Math.max(40, measured.get(nextKeys[index]) ?? estimate(item)));
    this.indexByKey = new Map(this.keys.map((key, index) => [key, index]));
    this.rebuildTree();
    return true;
  }

  window(offset: number, viewportHeight: number, overscan = 800): NoteListWindow {
    const start = this.lowerBound(Math.max(0, offset - overscan));
    const end = Math.min(this.keys.length, this.lowerBound(Math.max(0, offset + viewportHeight + overscan)) + 1);
    return {
      start,
      end,
      topSpacer: this.prefix(start),
      bottomSpacer: this.total - this.prefix(end),
      totalHeight: this.total
    };
  }

  measure(key: string, rawHeight: number) {
    const index = this.indexByKey.get(key);
    if (index === undefined || !Number.isFinite(rawHeight)) return null;
    const height = Math.max(40, Math.round(rawHeight));
    const delta = height - this.heights[index];
    if (Math.abs(delta) < 1) return null;
    this.heights[index] = height;
    this.add(index, delta);
    this.total += delta;
    return { index, delta };
  }

  keyAt(index: number) {
    return this.keys[index];
  }

  get length() {
    return this.keys.length;
  }

  private rebuildTree() {
    this.tree = new Array(this.heights.length + 1).fill(0);
    this.total = 0;
    for (let index = 1; index <= this.heights.length; index++) {
      this.tree[index] += this.heights[index - 1];
      const parent = index + (index & -index);
      if (parent < this.tree.length) this.tree[parent] += this.tree[index];
      this.total += this.heights[index - 1];
    }
  }

  private add(index: number, delta: number) {
    for (let cursor = index + 1; cursor < this.tree.length; cursor += cursor & -cursor) this.tree[cursor] += delta;
  }

  private prefix(endExclusive: number) {
    let sum = 0;
    for (let cursor = Math.min(endExclusive, this.heights.length); cursor > 0; cursor -= cursor & -cursor) sum += this.tree[cursor];
    return sum;
  }

  private lowerBound(offset: number) {
    let index = 0;
    let sum = 0;
    let bit = 1;
    while ((bit << 1) <= this.keys.length) bit <<= 1;
    for (; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next <= this.keys.length && sum + this.tree[next] <= offset) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(index, this.keys.length);
  }
}
