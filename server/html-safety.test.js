const test = require('node:test');
const assert = require('node:assert/strict');
const { neutralizeActiveHtml, neutralizeChecklist, hasActiveContent } = require('./html-safety');

const CLEAN = [
  '<div>ok &amp; <b>fine</b><br></div>',
  '<div><br></div>',
  'a &lt; b',
  '<div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="/api/uploads/images/a.png" alt="a"></div><div><br></div>'
];

test('editor-shaped html is returned byte for byte', () => {
  for (const html of CLEAN) assert.equal(neutralizeActiveHtml(html), html);
});

test('markup the parsers disagree about never survives as live markup', () => {
  const attacks = [
    '<![CDATA[><img src=x onerror=alert(1)>]]>',
    '<?x><img src=x onerror=alert(1)>',
    '</1><img src=x onerror=alert(1)>',
    '<img src=x onerror=alert(1)>',
    '<span data-original-html="<img src=x onerror=alert(1)>">a</span>',
    '<a href="javascript:alert(1)">x</a>'
  ];
  for (const html of attacks) {
    assert.equal(hasActiveContent(html), true, html);
    const clean = neutralizeActiveHtml(html);
    assert.doesNotMatch(clean, /onerror|javascript:|<!\[CDATA|<\?/i, html);
  }
});

test('checklist items are neutralized individually and clean ones are untouched', () => {
  const items = [{ id: 1, data: '<![CDATA[><img src=x onerror=1>]]>' }, { id: 2, data: 'fine' }];
  const [bad, good] = neutralizeChecklist(items);
  assert.doesNotMatch(bad.data, /onerror/);
  assert.equal(good, items[1]);
});
