import { CheckboxI } from '../interfaces/notes';
import { ChecklistHistory, normalizeChecklist, setChecklistIndent, toggleChecklistDone } from './checklist-model';

const row = (id: number, indentLevel = 0, done = false, data = `row ${id}`): CheckboxI => ({ id, indentLevel, done, data });

describe('normalizeChecklist', () => {
  it('keeps valid ids, repairs duplicate/missing ones and clamps depth', () => {
    const result = normalizeChecklist([
      { id: 3, done: true, data: 'a<b>x</b>', indentLevel: 9 },
      { id: 3, done: false, data: 'dup' },
      { id: undefined as any, done: false, data: null },
      { id: -1, done: false, data: 'neg' }
    ]);
    expect(result.map(r => r.id)).toEqual([3, 4, 5, 6]);
    expect(new Set(result.map(r => r.id)).size).toBe(4);
    expect(result[0]).toEqual({ id: 3, done: true, data: 'a<b>x</b>', indentLevel: 3 });
    expect(result[2].data).toBe('');
  });

  it('does not mutate its input', () => {
    const input = [row(1)];
    normalizeChecklist(input)[0].done = true;
    expect(input[0].done).toBeFalse();
  });
});

describe('setChecklistIndent', () => {
  it('moves nested rows with their parent and bounds depth by the row above', () => {
    const items = [row(1), row(2), row(3, 1), row(4, 2)];
    const result = setChecklistIndent(items, 2, 1)!;
    expect(result.map(r => r.indentLevel)).toEqual([0, 1, 2, 3]);
    expect(items.map(r => r.indentLevel)).toEqual([0, 0, 1, 2]);
    expect(setChecklistIndent(items, 1, 1)).toBeNull();
    expect(setChecklistIndent(items, 2, 3)!.find(r => r.id === 2)!.indentLevel).toBe(1);
    expect(setChecklistIndent(items, 99, 1)).toBeNull();
  });

  it('outdents children together with the parent', () => {
    const result = setChecklistIndent([row(1), row(2, 1), row(3, 2)], 2, 0)!;
    expect(result.map(r => r.indentLevel)).toEqual([0, 0, 1]);
  });
});

describe('toggleChecklistDone', () => {
  it('applies the new state to every nested row and only those', () => {
    const items = [row(1), row(2, 1), row(3, 2), row(4)];
    const result = toggleChecklistDone(items, 1)!;
    expect(result.map(r => r.done)).toEqual([true, true, true, false]);
    expect(items.every(r => !r.done)).toBeTrue();
    expect(toggleChecklistDone(result, 2)!.map(r => r.done)).toEqual([true, false, false, false]);
    expect(toggleChecklistDone(items, 42)).toBeNull();
  });
});

describe('ChecklistHistory', () => {
  let clock = 0;
  const history = () => new ChecklistHistory(() => ++clock);

  it('undoes and redoes structural changes and drops redo after a new change', () => {
    const h = history();
    h.reset([row(1)]);
    h.push([row(1), row(2)]);
    h.push([row(1), row(2), row(3)]);
    expect(h.shouldHandle('undo')).toBeTrue();
    expect(h.step('undo')!.length).toBe(2);
    expect(h.shouldHandle('redo')).toBeTrue();
    h.push([row(1), row(9)]);
    expect(h.canStep('redo')).toBeFalse();
    expect(h.step('undo')!.length).toBe(2);
    expect(h.step('undo')!.length).toBe(1);
    expect(h.step('undo')).toBeNull();
  });

  it('ignores identical states and bounds memory', () => {
    const h = history();
    h.reset([row(1)]);
    expect(h.push([row(1)])).toBeFalse();
    for (let i = 0; i < ChecklistHistory.LIMIT + 20; i++) h.push([row(1), row(i + 2)]);
    expect(h.length).toBe(ChecklistHistory.LIMIT);
  });

  it('leaves undo to the text field when typing happened after the last structural change', () => {
    const h = history();
    h.reset([row(1)]);
    h.push([row(1), row(2)]);
    h.textInput();
    expect(h.shouldHandle('undo')).toBeFalse();
    expect(h.shouldHandle('redo')).toBeFalse();
    h.push([row(1), row(2), row(3)]);
    expect(h.shouldHandle('undo')).toBeTrue();
  });

  it('returns copies so callers cannot corrupt stored snapshots', () => {
    const h = history();
    h.reset([row(1)]);
    h.push([row(1), row(2)]);
    h.step('undo')![0].data = 'changed';
    h.step('redo');
    expect(h.step('undo')![0].data).toBe('row 1');
  });
});
