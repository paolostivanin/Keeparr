import fixture from '../../../test-fixtures/native-contract.json';
import { splitBodyIntoLines, type LineNode } from './checklist-conversion';
import { escapeText, hasMeaningfulBody, sanitizeNotePreviewHtml, sanitizeRowHtml, titleHtml, titleText } from './keeparr-html';

// The shared editor fixtures (docs/note-content-contract.md) replayed against the real browser.
const editorHtml = (fixture as any).editorHtml;
const cases: any[] = editorHtml.cases;

describe('keeparr-html against the shared fixtures', () => {
  it('nonBlankLines equals splitBodyIntoLines over the parsed body', () => {
    for (const c of cases) {
      if (!('nonBlankLines' in c)) continue;
      const body = new DOMParser().parseFromString(c.html, 'text/html').body;
      expect(splitBodyIntoLines(body as unknown as LineNode).lines).withContext(c.id).toEqual(c.nonBlankLines);
    }
  });

  it('a pre-wrap element shows the fixture lines as its innerText when browserInnerText is set', () => {
    const element = document.createElement('div');
    element.style.whiteSpace = 'pre-wrap';
    document.body.appendChild(element);
    const mismatches: string[] = [];
    try {
      for (const c of cases.filter(entry => entry.browserInnerText)) {
        element.innerHTML = c.html;
        if (element.innerText !== c.lines.join('\n')) mismatches.push(`${c.id}: ${JSON.stringify(element.innerText)} != ${JSON.stringify(c.lines.join('\n'))}`);
      }
    } finally {
      element.remove();
    }
    expect(mismatches.join(' || ')).toBe('');
  });

  it('hasMeaningfulBody matches every case', () => {
    for (const c of cases) expect(hasMeaningfulBody(c.html)).withContext(c.id).toBe(c.hasMeaningfulBody);
    expect(hasMeaningfulBody(null)).toBeFalse();
    expect(hasMeaningfulBody(undefined)).toBeFalse();
  });

  it('titles read and write as the contract says', () => {
    for (const t of editorHtml.titles) {
      expect(titleText(t.html)).withContext(`${t.id} text`).toBe(t.text);
      expect(titleHtml(t.text)).withContext(`${t.id} written`).toBe(t.canonicalHtml ?? t.html);
      expect(titleHtml(t.text, t.html)).withContext(`${t.id} unchanged`).toBe(t.html);
    }
    for (const t of editorHtml.titleEdits) expect(titleHtml(t.text, t.original)).withContext(t.id).toBe(t.html);
  });

  it('sanitizeRowHtml keeps every row string a client may write, byte for byte', () => {
    for (const row of editorHtml.authoredRow as string[]) expect(sanitizeRowHtml(row)).withContext(row).toBe(row);
    for (const r of editorHtml.rows as any[]) {
      // A legacy entity in the input (`Caff&#232;`) is decoded; the strings clients write are fixed points.
      for (const expected of r.expected as string[]) expect(sanitizeRowHtml(expected)).withContext(`${r.id} expected`).toBe(expected);
      expect(titleText(sanitizeRowHtml(r.html))).withContext(`${r.id} input text`).toBe(titleText(r.html));
    }
  });
});

describe('sanitizeRowHtml', () => {
  it('keeps the inline vocabulary with its attributes', () => {
    for (const html of [
      '<strong>a</strong><em>b</em><s>c</s><strike>d</strike><del>e</del><code>f</code><sub>g</sub><sup>h</sup><mark>i</mark><small>j</small>',
      '<span style="color: red; font-weight: 700;">x</span>', '<font color="#ff0000" face="Arial">x</font>', 'a<br>b',
      '<a href="https://e.test/?q=1&amp;r=2" target="_blank" rel="noopener">link</a>', 'Tom &amp; Jerry &lt;3&nbsp;x',
    ]) expect(sanitizeRowHtml(html)).withContext(html).toBe(html);
  });

  it('drops scripts, handlers, unsafe links and unknown block markup but keeps the text', () => {
    expect(sanitizeRowHtml('a<script>alert(1)</script>b')).toBe('ab');
    expect(sanitizeRowHtml('<b onclick="x()" class="c">bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeRowHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRowHtml('<a href=" JaVaScRiPt:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRowHtml('<img src=x onerror=alert(1)>t')).toBe('t');
    expect(sanitizeRowHtml('<div>one</div><p>two</p>')).toBe('onetwo');
    expect(sanitizeRowHtml('<iframe src="https://x.test"></iframe>y')).toBe('y');
    expect(sanitizeRowHtml('<span style="background: url(https://x.test/a.png); color: blue">x</span>')).toBe('<span style="color: blue;">x</span>');
    expect(sanitizeRowHtml('<span data-future="keep" aria-label="value">x</span>')).toBe('<span data-future="keep" aria-label="value">x</span>');
    expect(sanitizeRowHtml('<a href="https://e.test" target="_blank">x</a>')).toBe('<a href="https://e.test" target="_blank" rel="noopener">x</a>');
  });

  it('is stable: sanitizing twice changes nothing', () => {
    const once = sanitizeRowHtml('<b>a</b> <u onmouseover="x">b</u><br><span style="color:red">c</span>');
    expect(sanitizeRowHtml(once)).toBe(once);
  });
});

describe('sanitizeNotePreviewHtml', () => {
  it('retains safe rich inline colors and note structure for card previews', () => {
    expect(sanitizeNotePreviewHtml('<div><span style="color:red;background-color:yellow">Important</span><ul><li>One</li></ul></div>'))
      .toBe('<div><span style="color: red; background-color: yellow;">Important</span><ul><li>One</li></ul></div>');
  });

  it('removes active content and unsafe attributes while retaining safe text', () => {
    expect(sanitizeNotePreviewHtml('<div onclick="x()"><script>alert(1)</script><a href="javascript:x()">safe</a><img src="javascript:x()" onerror="x()"></div>'))
      .toBe('<div><a>safe</a><img></div>');
  });

  it('prevents reverse-tabnabbing from preview links', () => {
    expect(sanitizeNotePreviewHtml('<a href="https://example.test" target="_blank" rel="opener">link</a>'))
      .toBe('<a href="https://example.test" target="_blank" rel="noopener">link</a>');
  });
});

describe('escapeText', () => {
  it('escapes & < > and writes U+00A0 as &nbsp;, leaving the rest literal', () => {
    expect(escapeText('a<b & c> "q" Caffè  x')).toBe('a&lt;b &amp; c&gt; "q" Caffè &nbsp;x');
  });
});
