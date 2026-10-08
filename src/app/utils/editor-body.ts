/**
 * Pure transformations between the stored note body (complete source HTML) and
 * the HTML shown inside the contenteditable. Link-preview slots and inline
 * image tools are editor chrome: they are added on load and stripped on save so
 * that the persisted document never contains them.
 */

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const TRAILING_PUNCTUATION = /[),.;:!?]+$/;

export function extractUrlsFromHtml(html: string, limit = 3): string[] {
  const urls = new Set<string>();
  const div = document.createElement('div');
  div.innerHTML = html || '';

  div.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
    const href = anchor.href || anchor.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) urls.add(href);
  });

  const matches = (div.textContent || '').match(URL_PATTERN) || [];
  matches.forEach(url => urls.add(url.replace(TRAILING_PUNCTUATION, '')));

  return [...urls].slice(0, limit);
}

export function removePreviewMarkup(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.editor-link-preview-slot').forEach(marker => {
    marker.querySelectorAll('.editor-link-preview-card').forEach(el => el.remove());
  });
  root.querySelectorAll<HTMLElement>('app-link-preview, .editor-link-previews, .lp-card, .editor-link-preview-card').forEach(el => el.remove());
}

function previewSlot(url: string, originalHtml: string) {
  const marker = document.createElement('span');
  marker.className = 'editor-link-preview-slot';
  marker.contentEditable = 'false';
  marker.dataset['url'] = url;
  marker.dataset['originalHtml'] = originalHtml;
  return marker;
}

/**
 * Replaces links and bare URLs with preview slots that remember their original
 * markup. `html` must already be in display form (authenticated image URLs).
 */
export function decorateLinks(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  removePreviewMarkup(div);

  div.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
    const href = anchor.href || anchor.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    anchor.replaceWith(previewSlot(href, anchor.outerHTML));
  });

  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const parent = node.parentElement;
      if (!parent || parent.closest('.editor-hidden-link')) return NodeFilter.FILTER_REJECT;
      return /https?:\/\/[^\s"'<>]+/.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  textNodes.forEach(node => {
    const text = node.textContent || '';
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      const rawUrl = match[0];
      const start = match.index || 0;
      const visibleUrl = rawUrl.replace(TRAILING_PUNCTUATION, '');
      const trailing = rawUrl.slice(visibleUrl.length);
      if (start > lastIndex) fragment.append(document.createTextNode(text.slice(lastIndex, start)));
      fragment.append(previewSlot(visibleUrl, visibleUrl));
      if (trailing) fragment.append(document.createTextNode(trailing));
      lastIndex = start + rawUrl.length;
    }
    if (lastIndex < text.length) fragment.append(document.createTextNode(text.slice(lastIndex)));
    node.replaceWith(fragment);
  });

  return div.innerHTML;
}

/** Restores the stored body from editor HTML (`html` already in canonical image form). */
export function stripEditorChrome(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  removePreviewMarkup(div);
  div.querySelectorAll('[data-inline-image-tool]').forEach(el => el.remove());
  div.querySelectorAll<HTMLElement>('.editor-link-preview-slot').forEach(marker => {
    const template = document.createElement('template');
    template.innerHTML = marker.dataset['originalHtml'] || marker.dataset['url'] || '';
    marker.replaceWith(template.content);
  });
  return div.innerHTML;
}
