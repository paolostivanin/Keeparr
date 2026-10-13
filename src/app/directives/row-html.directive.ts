import { Directive, ElementRef, Input, OnChanges } from '@angular/core';
import { sanitizeNotePreviewHtml, sanitizeRowHtml } from '../utils/keeparr-html';

/**
 * Writes a checklist row's html into its contenteditable element, replacing Angular's `[innerHTML]`.
 *
 * `[innerHTML]` re-assigns the element whenever the bound string changes, and it runs the string through
 * Angular's sanitizer, which strips row markup. Reading the typed text back into the model changes the string
 * without changing the DOM, so every sync reset the caret. Here the value goes through `sanitizeRowHtml`
 * (the contract's inline vocabulary) and the DOM is touched only when it really differs.
 */
@Directive({
  selector: '[appRowHtml]',
  standalone: false
})
export class RowHtmlDirective implements OnChanges {
  @Input('appRowHtml') html: unknown = '';

  constructor(private readonly host: ElementRef<HTMLElement>) {}

  ngOnChanges() {
    const element = this.host.nativeElement;
    const source = typeof this.html === 'string' ? this.html : '';
    const next = sanitizeRowHtml(source);
    if (element.innerHTML !== next) element.innerHTML = next;
    // The editor may normalize harmless legacy markup for display. Keep that
    // source string when the row itself was not edited, honoring the shared
    // untouched-content contract.
    element.dataset['sourceHtml'] = source;
    element.dataset['renderedHtml'] = next;
  }
}

/** Sanitized rich HTML for read-only card previews; unlike Angular innerHTML this retains safe styles. */
@Directive({ selector: '[appNotePreviewHtml]', standalone: false })
export class NotePreviewHtmlDirective implements OnChanges {
  @Input('appNotePreviewHtml') html: unknown = '';

  constructor(private readonly host: ElementRef<HTMLElement>) {}

  ngOnChanges() {
    const element = this.host.nativeElement;
    const next = sanitizeNotePreviewHtml(typeof this.html === 'string' ? this.html : '');
    if (element.innerHTML !== next) element.innerHTML = next;
  }
}
