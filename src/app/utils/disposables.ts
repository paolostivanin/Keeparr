/**
 * Owner for the timers, frames and listeners a view creates. Everything added
 * is released by `dispose()`, which is idempotent, and nothing can be added
 * afterwards: a deferred "attach listener" callback that fires after the view
 * is gone would otherwise leak a document-level listener.
 */
export class Disposables {
  private disposers = new Set<() => void>();
  private disposed = false;

  get isDisposed() { return this.disposed; }
  get size() { return this.disposers.size; }

  add(dispose: () => void): () => void {
    if (this.disposed) { dispose(); return () => {}; }
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      this.disposers.delete(once);
      dispose();
    };
    this.disposers.add(once);
    return once;
  }

  timeout(callback: () => void, ms = 0): () => void {
    if (this.disposed) return () => {};
    const handle = setTimeout(() => {
      forget();
      callback();
    }, ms);
    const forget = this.add(() => clearTimeout(handle));
    return forget;
  }

  frame(callback: () => void): () => void {
    if (this.disposed) return () => {};
    const handle = requestAnimationFrame(() => {
      forget();
      callback();
    });
    const forget = this.add(() => cancelAnimationFrame(handle));
    return forget;
  }

  listen<K extends keyof DocumentEventMap>(target: Document, type: K, handler: (event: DocumentEventMap[K]) => void, options?: AddEventListenerOptions | boolean): () => void;
  listen(target: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions | boolean): () => void;
  listen(target: EventTarget, type: string, handler: (event: any) => void, options?: AddEventListenerOptions | boolean): () => void {
    if (this.disposed) return () => {};
    target.addEventListener(type, handler, options);
    return this.add(() => target.removeEventListener(type, handler, options));
  }

  dispose() {
    this.disposed = true;
    const pending = [...this.disposers];
    this.disposers.clear();
    pending.forEach(fn => fn());
  }
}
