import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RowHtmlDirective } from './row-html.directive';

@Component({
  template: `<div id="row" contenteditable="true" [appRowHtml]="data"></div>`,
  standalone: false
})
class RowHostComponent {
  data: unknown = '<b>one</b> two';
}

describe('RowHtmlDirective', () => {
  let fixture: ComponentFixture<RowHostComponent>;
  let row: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ declarations: [RowHostComponent, RowHtmlDirective] }).compileComponents();
    fixture = TestBed.createComponent(RowHostComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    row = fixture.nativeElement.querySelector('#row');
  });

  /** Sets the bound model the way the editor does and re-renders. */
  function bind(value: unknown) {
    fixture.componentInstance.data = value;
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
  }

  afterEach(() => { fixture.nativeElement.remove(); window.getSelection()?.removeAllRanges(); });

  it('writes the row markup, which Angular\'s innerHTML sanitizer would have stripped', () => {
    bind('<span style="color: red;">red</span> <font color="#00f">blue</font>');
    expect(row.innerHTML).toBe('<span style="color: red;">red</span> <font color="#00f">blue</font>');
  });

  it('keeps the caret when the model catches up with what was typed (W8)', () => {
    row.focus();
    row.firstChild!.textContent = 'one';
    const caret = document.createRange();
    caret.setStart(row.firstChild!.firstChild!, 2);
    caret.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(caret);
    const node = row.firstChild;

    // syncCboxDomIntoModel(): the model takes the DOM's current html, which changes the bound string but not the DOM.
    bind(row.innerHTML);

    expect(row.firstChild).toBe(node);
    expect(window.getSelection()!.anchorNode).toBe(node!.firstChild);
    expect(window.getSelection()!.anchorOffset).toBe(2);
  });

  it('rewrites the row when the model really differs, and strips unsafe markup', () => {
    bind('plain <img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>');
    expect(row.innerHTML).toBe('plain <a>x</a>');
    bind({ type: 'keeparr-future-item' });
    expect(row.innerHTML).toBe('');
  });
});
