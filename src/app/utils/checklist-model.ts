import type { CheckboxI } from '../interfaces/notes';
import { MAX_INDENT_LEVEL, descendantIndexes, maxIndentLevelAt, normalizeIndentLevel, normalizeIndentLevels } from './checkbox-indent';
import { canHideCheckboxes, checkBoxesToBodyHtml, linesToCheckBoxes, splitBodyIntoLines, type ChecklistItem, type LineNode } from './checklist-conversion';

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
      ...item,
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

const isText = (item: CheckboxI) => typeof item.data === 'string';

/** Visible text of a row's html: tags dropped, U+00A0 counted as a space. */
export function checklistRowText(data: unknown): string {
  return typeof data === 'string' ? data.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, ' ').trim() : '';
}

/** One more than the highest numeric id; ids are never reused. */
function nextChecklistId(items: CheckboxI[]): number {
  const numeric = items.map(item => Number(item.id)).filter(id => Number.isSafeInteger(id) && id >= 0);
  return (numeric.length ? Math.max(...numeric) : -1) + 1;
}

/**
 * Enter inside a row: the row keeps `left`, a new unchecked row with `right` follows it at the same depth
 * (before the row's children). Structured rows cannot be split.
 */
export function splitChecklistRow(items: CheckboxI[], id: number, left: string, right: string): CheckboxI[] | null {
  const index = items.findIndex(cb => cb.id === id);
  if (index < 0 || !isText(items[index])) return null;
  const row: CheckboxI = { id: nextChecklistId(items), done: false, data: right, indentLevel: normalizeIndentLevel(items[index].indentLevel) };
  const result = [...items];
  result[index] = { ...items[index], data: left };
  result.splice(index + 1, 0, row);
  return result;
}

/**
 * Backspace at a row's true start. A row without visible text is deleted. Otherwise its html is appended to the
 * previous visible row (`visibleIds` in display order, default list order), which keeps its id, state and depth.
 * Null when nothing applies: unknown row, structured row on either side, or no previous row.
 */
export function mergeChecklistRow(items: CheckboxI[], id: number, visibleIds?: number[]): CheckboxI[] | null {
  const index = items.findIndex(cb => cb.id === id);
  if (index < 0 || !isText(items[index])) return null;
  if (!checklistRowText(items[index].data)) return items.filter(cb => cb.id !== id);
  const previousId = visibleIds ? visibleIds[visibleIds.indexOf(id) - 1] : items[index - 1]?.id;
  const previousIndex = previousId === undefined ? -1 : items.findIndex(cb => cb.id === previousId);
  if (previousIndex < 0 || previousIndex === index || !isText(items[previousIndex])) return null;
  const result = [...items];
  result[previousIndex] = { ...items[previousIndex], data: String(items[previousIndex].data) + String(items[index].data) };
  return result.filter(cb => cb.id !== id);
}

/** Removes only that row (its children stay). */
export function removeChecklistRow(items: CheckboxI[], id: number): CheckboxI[] | null {
  return items.some(cb => cb.id === id) ? items.filter(cb => cb.id !== id) : null;
}

/** Moves one row before `beforeId` (null: to the end), then re-clamps depths. Null when the order does not change. */
export function moveChecklistBefore(items: CheckboxI[], id: number, beforeId: number | null): CheckboxI[] | null {
  const from = items.findIndex(cb => cb.id === id);
  if (from < 0 || beforeId === id) return null;
  const rest = items.filter(cb => cb.id !== id);
  const to = beforeId === null ? rest.length : rest.findIndex(cb => cb.id === beforeId);
  if (to < 0) return null;
  const result = [...rest.slice(0, to), items[from], ...rest.slice(to)];
  if (result.every((cb, i) => cb === items[i])) return null;
  return normalizeIndentLevels(result);
}

/** "Show checkboxes": one unchecked row per body line; only embeds (images, wrappers) stay in the body. */
export function showChecklistFromBody(items: CheckboxI[], body: LineNode): { items: CheckboxI[]; body: string } {
  const { lines, leftoverHtml } = splitBodyIntoLines(body);
  return { items: [...items, ...linesToCheckBoxes(lines, items as ChecklistItem[]) as CheckboxI[]], body: leftoverHtml };
}

/** "Hide checkboxes": unchecked rows become lines after the kept body; null when a structured row would be lost. */
export function hideChecklistToBody(items: CheckboxI[], body: string): { items: CheckboxI[]; body: string } | null {
  if (!canHideCheckboxes(items as ChecklistItem[])) return null;
  return { items: [], body: body + checkBoxesToBodyHtml(items as ChecklistItem[]) };
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

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

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

  textInput(items?: CheckboxI[]) {
    // Text lives in the row DOM between structural edits. Fold the latest value
    // into this checkpoint so structural undo preserves typing that came first.
    if (items && this.index >= 0) this.snapshots[this.index] = normalizeChecklist(items);
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
