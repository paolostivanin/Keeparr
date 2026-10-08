/**
 * Undo/redo stack of drawing canvas snapshots (PNG data URLs). A snapshot is
 * hundreds of KB, so the stack is bounded by entry count and by total
 * characters; the oldest entries are dropped first and the current state plus
 * one undo step always survive.
 */
export class DrawingHistory {
  static readonly MAX_ENTRIES = 40;
  static readonly MAX_CHARS = 24 * 1024 * 1024;

  private entries: string[] = [];
  private index = -1;
  private chars = 0;

  constructor(
    private readonly maxEntries = DrawingHistory.MAX_ENTRIES,
    private readonly maxChars = DrawingHistory.MAX_CHARS
  ) {}

  get length() { return this.entries.length; }
  get size() { return this.chars; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index >= 0 && this.index < this.entries.length - 1; }
  get current(): string | undefined { return this.entries[this.index]; }

  reset(initial?: string) {
    this.entries = [];
    this.index = -1;
    this.chars = 0;
    if (initial) this.push(initial);
  }

  push(dataUrl: string) {
    for (const dropped of this.entries.splice(this.index + 1)) this.chars -= dropped.length;
    this.entries.push(dataUrl);
    this.chars += dataUrl.length;
    while (this.entries.length > 2 && (this.entries.length > this.maxEntries || this.chars > this.maxChars)) {
      this.chars -= this.entries.shift()!.length;
    }
    this.index = this.entries.length - 1;
  }

  undo(): string | undefined {
    if (!this.canUndo) return undefined;
    return this.entries[--this.index];
  }

  redo(): string | undefined {
    if (!this.canRedo) return undefined;
    return this.entries[++this.index];
  }
}
