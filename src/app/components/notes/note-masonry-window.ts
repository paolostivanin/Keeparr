export interface MasonryWindowPlacement<T> {
  key: string;
  item: T;
  index: number;
  column: number;
  top: number;
  height: number;
}

export interface MasonryWindowResult<T> {
  placements: MasonryWindowPlacement<T>[];
  totalHeight: number;
  columnWidth: number;
  gutter: number;
}

/** Shortest-column masonry placement with a bounded vertical render window. */
export class NoteMasonryWindowModel<T> {
  private keys: string[] = [];
  private items: readonly T[] = [];
  private heights: number[] = [];
  private columns: MasonryWindowPlacement<T>[][] = [];
  private placementsByKey = new Map<string, MasonryWindowPlacement<T>>();
  private total = 0;
  private columnCount = 0;
  private width = 0;
  private gutter = 0;

  setItems(items: readonly T[], keyOf: (item: T) => string, estimate: (item: T) => number,
    columnCount: number, columnWidth: number, gutter: number) {
    const keys = items.map(keyOf);
    const nextColumns = Math.max(1, columnCount);
    const nextWidth = Math.max(1, columnWidth);
    const nextGutter = Math.max(0, gutter);
    if (this.sameLayout(keys, nextColumns, nextWidth, nextGutter)) return false;
    const measured = new Map(this.keys.map((key, index) => [key, this.heights[index]]));
    this.keys = keys;
    this.items = items;
    this.heights = items.map((item, index) => Math.max(40, measured.get(keys[index]) ?? estimate(item)));
    this.columnCount = nextColumns;
    this.width = nextWidth;
    this.gutter = nextGutter;
    this.repack();
    return true;
  }

  window(offset: number, viewportHeight: number, overscan = 800): MasonryWindowResult<T> {
    const min = Math.max(0, offset - overscan);
    const max = Math.max(0, offset + viewportHeight + overscan);
    const placements: MasonryWindowPlacement<T>[] = [];
    for (const column of this.columns) {
      let low = 0;
      let high = column.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (column[middle].top + column[middle].height < min) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < column.length && column[index].top <= max; index++) placements.push(column[index]);
    }
    placements.sort((left, right) => left.index - right.index);
    return { placements, totalHeight: this.total, columnWidth: this.width, gutter: this.gutter };
  }

  measure(key: string, rawHeight: number) {
    return this.measureMany([{ key, height: rawHeight }]);
  }

  measureMany(measurements: readonly { key: string; height: number }[]) {
    let changed = false;
    for (const measurement of measurements) {
      const placement = this.placementsByKey.get(measurement.key);
      if (!placement || !Number.isFinite(measurement.height)) continue;
      const height = Math.max(40, Math.round(measurement.height));
      if (Math.abs(height - placement.height) < 1) continue;
      this.heights[placement.index] = height;
      changed = true;
    }
    if (changed) this.repack();
    return changed;
  }

  placement(key: string) {
    return this.placementsByKey.get(key);
  }

  private sameLayout(keys: string[], columns: number, width: number, gutter: number) {
    return columns === this.columnCount && width === this.width && gutter === this.gutter
      && keys.length === this.keys.length && keys.every((key, index) => key === this.keys[index]);
  }

  private repack() {
    this.columns = Array.from({ length: this.columnCount }, () => []);
    this.placementsByKey.clear();
    const heights = new Array(this.columnCount).fill(0);
    for (let index = 0; index < this.items.length; index++) {
      let column = 0;
      for (let candidate = 1; candidate < heights.length; candidate++) {
        if (heights[candidate] < heights[column]) column = candidate;
      }
      const placement: MasonryWindowPlacement<T> = {
        key: this.keys[index],
        item: this.items[index],
        index,
        column,
        top: heights[column],
        height: this.heights[index]
      };
      this.columns[column].push(placement);
      this.placementsByKey.set(placement.key, placement);
      heights[column] += placement.height + this.gutter;
    }
    this.total = Math.max(0, ...heights) - (this.items.length ? this.gutter : 0);
  }
}
