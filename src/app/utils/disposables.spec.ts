import { Disposables } from './disposables';

describe('Disposables', () => {
  it('cancels pending timeouts and frames on dispose', async () => {
    const bag = new Disposables();
    let fired = 0;
    bag.timeout(() => fired++, 5);
    bag.frame(() => fired++);
    expect(bag.size).toBe(2);
    bag.dispose();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(fired).toBe(0);
    expect(bag.size).toBe(0);
  });

  it('forgets a timeout once it has fired', async () => {
    const bag = new Disposables();
    let fired = 0;
    bag.timeout(() => fired++, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fired).toBe(1);
    expect(bag.size).toBe(0);
  });

  it('does not attach a deferred listener after disposal', async () => {
    const bag = new Disposables();
    const target = document.createElement('div');
    const add = spyOn(target, 'addEventListener').and.callThrough();
    bag.timeout(() => bag.listen(target, 'click', () => {}), 0);
    bag.dispose();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(add).not.toHaveBeenCalled();
    bag.listen(target, 'click', () => {});
    expect(add).not.toHaveBeenCalled();
  });

  it('removes listeners, runs each disposer once, and tolerates repeated dispose', () => {
    const bag = new Disposables();
    const target = document.createElement('div');
    let clicks = 0;
    bag.listen(target, 'click', () => clicks++);
    target.click();
    let released = 0;
    bag.add(() => released++);
    bag.dispose();
    bag.dispose();
    target.click();
    expect(clicks).toBe(1);
    expect(released).toBe(1);
  });

  it('runs a disposer added after disposal immediately', () => {
    const bag = new Disposables();
    bag.dispose();
    let released = 0;
    bag.add(() => released++);
    expect(released).toBe(1);
  });

  it('lets a caller cancel one item early', async () => {
    const bag = new Disposables();
    let fired = 0;
    const cancel = bag.timeout(() => fired++, 0);
    cancel();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fired).toBe(0);
    expect(bag.size).toBe(0);
  });
});
