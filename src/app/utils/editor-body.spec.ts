import { decorateLinks, extractUrlsFromHtml, stripEditorChrome } from './editor-body';

describe('editor body transformations', () => {
  const roundTrip = (html: string) => stripEditorChrome(decorateLinks(html));

  it('round-trips rich formatting, links, bare URLs and inline objects unchanged', () => {
    const html = '<h1>Title</h1><p><b>bold</b> <i>it</i> <u>u</u></p>'
      + '<a href="https://example.com/a" target="_blank">label</a> and https://example.org/path, then text'
      + '<div class="inline-image-wrap" data-x="1"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="a"></div><ul><li>one</li></ul>';
    expect(roundTrip(html)).toBe(html);
  });

  it('turns links into non-editable slots that remember their source', () => {
    const slots = document.createElement('div');
    slots.innerHTML = decorateLinks('<a href="https://example.com/">x</a> see https://example.org.');
    const found = slots.querySelectorAll<HTMLElement>('.editor-link-preview-slot');
    expect(found.length).toBe(2);
    expect(found[0].dataset['originalHtml']).toContain('<a href="https://example.com/">x</a>');
    expect(found[1].dataset['url']).toBe('https://example.org');
    expect(slots.textContent).toContain('.');
  });

  it('does not persist preview cards or inline image tools', () => {
    const html = '<span class="editor-link-preview-slot" data-url="https://a.test" data-original-html="https://a.test">'
      + '<div class="editor-link-preview-card">card</div></span><span data-inline-image-tool>x</span>';
    expect(stripEditorChrome(html)).toBe('https://a.test');
  });

  it('extracts at most three distinct http(s) URLs without trailing punctuation', () => {
    const urls = extractUrlsFromHtml('<a href="https://a.test/">a</a> https://a.test/, https://b.test) https://c.test; https://d.test javascript:alert(1)');
    expect(urls.length).toBe(3);
    expect(urls[0]).toBe('https://a.test/');
    expect(urls).not.toContain('https://d.test');
    expect(urls.every(u => !/[),;]$/.test(u))).toBeTrue();
  });
});
