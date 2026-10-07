import { Subject, takeUntil } from 'rxjs';
import { RequestGate, StaleRequestError } from './request-gate';

describe('RequestGate', () => {
  it('lets only the latest ticket publish and expires older ones at once', () => {
    const gate = new RequestGate();
    const first = gate.begin();
    expect(first.current).toBeTrue();
    const second = gate.begin();
    expect(first.current).toBeFalse();
    expect(second.current).toBeTrue();
    expect(() => first.assertCurrent()).toThrowError(StaleRequestError);
    expect(() => second.assertCurrent()).not.toThrow();
  });

  it('hands out tickets for the current version without expiring anything, until invalidated', () => {
    const gate = new RequestGate();
    const list = gate.begin();
    const nextPage = gate.current();
    expect(list.current && nextPage.current).toBeTrue();
    gate.invalidate();
    expect(list.current || nextPage.current).toBeFalse();
  });

  it('signals expiry so in-flight requests can be cancelled, including tickets that are already stale', () => {
    const gate = new RequestGate();
    const ticket = gate.begin();
    let fired = 0;
    ticket.expired$.subscribe(() => fired++);
    expect(fired).toBe(0);
    gate.begin();
    expect(fired).toBe(1);

    let late = 0;
    ticket.expired$.subscribe(() => late++);
    expect(late).toBe(1);
  });

  it('cancels an HTTP-like stream through takeUntil when superseded', () => {
    const gate = new RequestGate();
    const ticket = gate.begin();
    const source = new Subject<string>();
    const seen: string[] = [];
    let completed = false;
    source.pipe(takeUntil(ticket.expired$)).subscribe({ next: value => seen.push(value), complete: () => { completed = true; } });
    source.next('before');
    gate.invalidate();
    source.next('after');
    expect(seen).toEqual(['before']);
    expect(completed).toBeTrue();
  });
});
