import { NoteListWindowModel } from './note-list-window';

describe('NoteListWindowModel', () => {
  it('calculates overscanned variable-height windows and spacer offsets', () => {
    const model = new NoteListWindowModel<{ id: string; estimate: number }>();
    const rows = [
      { id: 'a', estimate: 100 },
      { id: 'b', estimate: 200 },
      { id: 'c', estimate: 300 },
      { id: 'd', estimate: 400 }
    ];
    model.setItems(rows, row => row.id, row => row.estimate);

    expect(model.window(220, 100, 50)).toEqual({ start: 1, end: 3, topSpacer: 100, bottomSpacer: 400, totalHeight: 1000 });
  });

  it('updates measured heights in logarithmic offsets and preserves measurements by stable key', () => {
    const model = new NoteListWindowModel<{ id: string; estimate: number }>();
    const rows = [{ id: 'a', estimate: 100 }, { id: 'b', estimate: 100 }, { id: 'c', estimate: 100 }];
    model.setItems(rows, row => row.id, row => row.estimate);
    expect(model.measure('a', 150)?.delta).toBe(50);
    model.setItems([rows[2], rows[0], rows[1]], row => row.id, row => row.estimate);

    expect(model.window(125, 1, 0).start).toBe(1);
    expect(model.window(125, 1, 0).topSpacer).toBe(100);
    expect(model.measure('missing', 200)).toBeNull();
  });

  it('keeps only the currently requested row window in the returned range', () => {
    const model = new NoteListWindowModel<{ id: number }>();
    const rows = Array.from({ length: 10_000 }, (_, id) => ({ id }));
    model.setItems(rows, row => String(row.id), () => 120);

    const visible = model.window(600_000, 900, 600);

    expect(visible.end - visible.start).toBeLessThan(20);
    expect(visible.topSpacer + visible.bottomSpacer + (visible.end - visible.start) * 120).toBe(1_200_000);
  });

  it('keeps measured heights when a pin or reorder moves a row, and re-windows around the new order', () => {
    const model = new NoteListWindowModel<{ id: string }>();
    const rows = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
    model.setItems(rows, row => row.id, () => 100);
    model.measure('e', 400);

    // Pinning 'e' moves it to the top: its measured height travels with it.
    expect(model.setItems([rows[4], ...rows.slice(0, 4)], row => row.id, () => 100)).toBeTrue();

    const top = model.window(0, 300, 0);
    expect(model.keyAt(0)).toBe('e');
    expect(top.start).toBe(0);
    expect(top.end).toBe(1);
    expect(top.totalHeight).toBe(800);
    expect(model.window(400, 100, 0).start).toBe(1);
  });

  it('reports no change for an identical key order so an unrelated publication does not re-window', () => {
    const model = new NoteListWindowModel<{ id: string }>();
    const rows = ['a', 'b'].map(id => ({ id }));
    expect(model.setItems(rows, row => row.id, () => 100)).toBeTrue();
    expect(model.setItems(rows.map(row => ({ ...row })), row => row.id, () => 100)).toBeFalse();
  });
});
