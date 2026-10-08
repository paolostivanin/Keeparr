import { DrawingHistory } from './drawing-history';

const png = (name: string, size = 10) => `${name}:${'x'.repeat(size)}`;

describe('DrawingHistory', () => {
  it('undoes, redoes and discards redo entries after a new stroke', () => {
    const h = new DrawingHistory();
    h.reset(png('blank'));
    h.push(png('a'));
    h.push(png('b'));
    expect(h.undo()).toBe(png('a'));
    expect(h.canRedo).toBeTrue();
    h.push(png('c'));
    expect(h.canRedo).toBeFalse();
    expect(h.undo()).toBe(png('a'));
    expect(h.undo()).toBe(png('blank'));
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBe(png('a'));
    expect(h.current).toBe(png('a'));
  });

  it('bounds the number of snapshots by dropping the oldest', () => {
    const h = new DrawingHistory(5, Infinity);
    h.reset(png('0'));
    for (let i = 1; i <= 20; i++) h.push(png(String(i)));
    expect(h.length).toBe(5);
    expect(h.current).toBe(png('20'));
    let steps = 0;
    while (h.undo()) steps++;
    expect(steps).toBe(4);
  });

  it('bounds memory by total size but always keeps the current state and one undo step', () => {
    const h = new DrawingHistory(100, 1000);
    h.reset(png('0', 400));
    h.push(png('1', 400));
    h.push(png('2', 400));
    expect(h.size).toBeLessThanOrEqual(1000);
    expect(h.length).toBe(2);
    h.push(png('huge', 5000));
    expect(h.length).toBe(2);
    expect(h.canUndo).toBeTrue();
    expect(h.current).toBe(png('huge', 5000));
  });

  it('tracks size accurately across truncation and reset', () => {
    const h = new DrawingHistory();
    h.reset(png('0', 100));
    h.push(png('1', 100));
    h.push(png('2', 100));
    h.undo();
    h.push(png('3', 50));
    expect(h.size).toBe(png('0', 100).length + png('1', 100).length + png('3', 50).length);
    h.reset();
    expect(h.size).toBe(0);
    expect(h.canUndo).toBeFalse();
    expect(h.current).toBeUndefined();
  });
});
