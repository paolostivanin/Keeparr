import { Observable, Subject } from 'rxjs';

/** Raised when a request's result is no longer wanted because a newer request or a context change superseded it. */
export class StaleRequestError extends Error {
  constructor() {
    super('The request was superseded.');
    this.name = 'StaleRequestError';
  }
}

export interface RequestTicket {
  /** True until a newer request begins or the gate is invalidated. */
  readonly current: boolean;
  /** Emits once when this ticket expires; use with `takeUntil` to cancel the HTTP request. */
  readonly expired$: Observable<void>;
  /** Throws `StaleRequestError` if the ticket expired. */
  assertCurrent(): void;
}

/**
 * Versions asynchronous work that publishes into shared state (search, paging,
 * hydration, editor opens). Only the latest ticket may publish; starting newer
 * work or changing context (query, account) expires older tickets at once.
 */
export class RequestGate {
  private version = 0;
  private expiry = new Subject<void>();

  /** Start new work, expiring everything before it. */
  begin(): RequestTicket {
    this.invalidate();
    return this.ticket();
  }

  /** A ticket for the current version without expiring anything (e.g. next-page work that belongs to the current list). */
  current(): RequestTicket {
    return this.ticket();
  }

  /** Expire all outstanding tickets without starting new work. */
  invalidate() {
    this.version++;
    const previous = this.expiry;
    this.expiry = new Subject<void>();
    previous.next();
    previous.complete();
  }

  private ticket(): RequestTicket {
    const version = this.version;
    const gate = this;
    const expired$ = new Observable<void>(subscriber => {
      if (gate.version !== version) {
        subscriber.next();
        subscriber.complete();
        return undefined;
      }
      return gate.expiry.subscribe(subscriber);
    });
    return {
      get current() { return gate.version === version; },
      expired$,
      assertCurrent() { if (gate.version !== version) throw new StaleRequestError(); }
    };
  }
}
