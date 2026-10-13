let inertDocument: Document | undefined;

/**
 * An element to read or transform note html with. It belongs to a document without a browsing context, so images in it
 * never load and event-handler attributes never fire, which they would on a detached element of the page itself.
 */
export function inertDiv(html: string): HTMLDivElement {
  inertDocument ??= document.implementation.createHTMLDocument('');
  const div = inertDocument.createElement('div');
  div.innerHTML = html || '';
  return div;
}
