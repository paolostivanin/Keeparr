import { CheckboxI } from '../interfaces/notes';
import { MAX_INDENT_LEVEL, descendantIndexes, maxIndentLevelAt, normalizeIndentLevel } from './checkbox-indent';

/**
 * Framework-free checklist document operations. The editor component owns the
 * DOM and the session; everything here maps one checklist array to the next
 * without mutating its input.
 */

/** Gives every row a unique non-negative integer id and normalizes its shape. */
export function normalizeChecklist(checkBoxes: CheckboxI[] = []): CheckboxI[] {
  const numericIds = checkBoxes
    .map(item => Number((item as any)?.id))
    .filter(id => Number.isSafeInteger(id) && id >= 0);
  let nextId = numericIds.length ? Math.max(...numericIds) + 1 : 0;
  const usedIds = new Set<number>();
  const nextAvailableId = () => {
    while (usedIds.has(nextId)) nextId++;
    return nextId++;
  };

  return checkBoxes.map(item => {
    const numericId = Number((item as any)?.id);
    let id: number;
    if (Number.isSafeInteger(numericId) && numericId >= 0 && !usedIds.has(numericId)) id = numericId;
    else id = nextAvailableId();
    usedIds.add(id);
    return {
      id,
      done: !!item.done,
      data: item.data || '',
      indentLevel: normalizeIndentLevel(item.indentLevel)
    };
  });
}

/** Sets a row's depth (bounded by the row above) and moves its children with it. */
export function setChecklistIndent(items: CheckboxI[], id: number, indentLevel: number): CheckboxI[] | null {
  const index = items.findIndex(cb => cb.id === id);
  if (index < 0) return null;
  const current = normalizeIndentLevel(items[index].indentLevel);
  const next = Math.min(normalizeIndentLevel(indentLevel), maxIndentLevelAt(items, index));
  if (current === next) return null;

  const delta = next - current;
  const result = [...items];
  for (const childIndex of descendantIndexes(items, index)) {
    result[childIndex] = { ...items[childIndex], indentLevel: normalizeIndentLevel(normalizeIndentLevel(items[childIndex].indentLevel) + delta) };
  }
  result[index] = { ...items[index], indentLevel: next };
  return result;
}

/** Toggles a row and applies the new state to every nested row below it. */
export function toggleChecklistDone(items: CheckboxI[], id: number): CheckboxI[] | null {
  const index = items.findIndex(cb => cb.id === id);
  if (index < 0) return null;
  const done = !items[index].done;
  const result = [...items];
  result[index] = { ...items[index], done };
  for (const childIndex of descendantIndexes(items, index)) result[childIndex] = { ...items[childIndex], done };
  return result;
}

export { MAX_INDENT_LEVEL };

export type ChecklistHistoryCommand = 'undo' | 'redo';

/**
 * Structural undo/redo for checklist edits. Text typed inside a row stays with
 * the browser's own undo stack; `textInput()` records which of the two most
 * recently changed so Ctrl+Z picks the right one.
 */
export class ChecklistHistory {
  static readonly LIMIT = 80;
  private snapshots: CheckboxI[][] = [];
  private index = -1;
  private lastStructuralChangeAt = 0;
  private lastTextInputAt = 0;
  private redoMode = false;

  constructor(private readonly now: () => number = Date.now) {}

  get length() { return this.snapshots.length; }

  reset(items: CheckboxI[]) {
    this.snapshots = [normalizeChecklist(items)];
    this.index = 0;
    this.lastStructuralChangeAt = 0;
    this.lastTextInputAt = 0;
    this.redoMode = false;
  }

  /** Records a structural change; identical consecutive states are ignored. */
  push(items: CheckboxI[]) {
    const snapshot = normalizeChecklist(items);
    const previous = this.snapshots[this.index];
    if (previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return false;
    this.snapshots = this.snapshots.slice(0, this.index + 1);
    this.snapshots.push(snapshot);
    if (this.snapshots.length > ChecklistHistory.LIMIT) this.snapshots.shift();
    this.index = this.snapshots.length - 1;
    this.lastStructuralChangeAt = this.now();
    this.redoMode = true;
    return true;
  }

  textInput() {
    this.lastTextInputAt = this.now();
    this.redoMode = false;
  }

  canStep(command: ChecklistHistoryCommand) {
    return command === 'undo' ? this.index > 0 : this.index >= 0 && this.index < this.snapshots.length - 1;
  }

  /** Whether the checklist (not the focused text field) should handle the command. */
  shouldHandle(command: ChecklistHistoryCommand) {
    if (!this.canStep(command)) return false;
    if (command === 'redo') return this.redoMode;
    return this.lastStructuralChangeAt >= this.lastTextInputAt;
  }

  step(command: ChecklistHistoryCommand): CheckboxI[] | null {
    if (!this.canStep(command)) return null;
    this.index += command === 'undo' ? -1 : 1;
    this.redoMode = this.canStep('redo');
    return normalizeChecklist(this.snapshots[this.index]);
  }
}
