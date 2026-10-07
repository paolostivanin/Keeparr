import { dragAutoScrollDelta } from './drag-autoscroll';

describe('dragAutoScrollDelta', () => {
  it('does nothing in the middle of the viewport or for unusable input', () => {
    expect(dragAutoScrollDelta(400, 800)).toBe(0);
    expect(dragAutoScrollDelta(NaN, 800)).toBe(0);
    expect(dragAutoScrollDelta(10, 0)).toBe(0);
  });

  it('scrolls up near the top edge and down near the bottom edge', () => {
    expect(dragAutoScrollDelta(20, 800)).toBeLessThan(0);
    expect(dragAutoScrollDelta(780, 800)).toBeGreaterThan(0);
  });

  it('speeds up the deeper the pointer is in the zone and is capped at the maximum', () => {
    const shallow = dragAutoScrollDelta(800 - 90, 800);
    const deep = dragAutoScrollDelta(800 - 10, 800);
    expect(Math.abs(deep)).toBeGreaterThan(Math.abs(shallow));
    expect(dragAutoScrollDelta(5000, 800)).toBe(18);
    expect(dragAutoScrollDelta(-500, 800)).toBe(-18);
    expect(dragAutoScrollDelta(-500, 800, 30)).toBe(-30);
  });

  it('shrinks the edge zone on small viewports so the middle stays inert', () => {
    expect(dragAutoScrollDelta(150, 300)).toBe(0);
    expect(dragAutoScrollDelta(40, 300)).toBeLessThan(0);
  });
});
