import { NgZone } from '@angular/core';
import { NavComponent } from './sidenav.component';

describe('NavComponent overflow cues', () => {
  const create = () => {
    const zone = new NgZone({ enableLongStackTrace: false });
    const run = spyOn(zone, 'run').and.callThrough();
    const component = new NavComponent({ initPwa: () => {} } as any, {} as any, {} as any, zone);
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 400 });
    Object.defineProperty(el, 'clientHeight', { value: 100 });
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    component.labelsScroll = { nativeElement: el } as any;
    return { component, el, run };
  };

  it('publishes a changed scroll cue inside the Angular zone', () => {
    const { component, el, run } = create();
    (component as any).updateLabelsOverflowState();
    expect(component.canScrollDown).toBeTrue();
    expect(component.canScrollUp).toBeFalse();
    expect(run).toHaveBeenCalledTimes(1);

    el.scrollTop = 150;
    (component as any).updateLabelsOverflowState();
    expect(component.canScrollUp).toBeTrue();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not trigger a change-detection pass when the cue is unchanged', () => {
    const { component, run } = create();
    (component as any).updateLabelsOverflowState();
    run.calls.reset();
    (component as any).updateLabelsOverflowState();
    expect(run).not.toHaveBeenCalled();
  });
});
