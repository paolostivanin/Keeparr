import { NoteMasonryWindowModel } from './note-masonry-window';

describe('NoteMasonryWindowModel', () => {
  it('packs by shortest column and returns only vertically intersecting cards', () => {
    const model = new NoteMasonryWindowModel<{ id: string; height: number }>();
    const rows = [
      { id: 'a', height: 100 },
      { id: 'b', height: 200 },
      { id: 'c', height: 150 },
      { id: 'd', height: 200 }
    ];
    model.setItems(rows, row => row.id, row => row.height, 2, 240, 10);

    const window = model.window(150, 100, 0);

    expect(window.totalHeight).toBe(410);
    expect(window.placements.map(item => item.key)).toEqual(['b', 'c', 'd']);
    expect(window.placements.map(item => item.column)).toEqual([1, 0, 1]);
  });

  it('reflows measured heights and retains measurements across a keyed reorder', () => {
    const model = new NoteMasonryWindowModel<{ id: string; height: number }>();
    const rows = [{ id: 'a', height: 100 }, { id: 'b', height: 100 }, { id: 'c', height: 100 }];
    model.setItems(rows, row => row.id, row => row.height, 2, 200, 8);
    expect(model.measure('a', 220)).toBeTrue();
    expect(model.placement('a')?.height).toBe(220);

    model.setItems([rows[2], rows[0], rows[1]], row => row.id, row => row.height, 2, 200, 8);

    expect(model.placement('a')?.height).toBe(220);
    expect(model.placement('a')?.index).toBe(1);
  });
});
