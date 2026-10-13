// node --test src/app/utils/native-contract-fixtures.test.ts
// Loader and consistency checks for the shared editor fixtures (docs/note-content-contract.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { splitBodyIntoLines, type LineNode } from './checklist-conversion.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../test-fixtures/native-contract.json', import.meta.url), 'utf8'));
const editorHtml = fixture.editorHtml;
const EMBED = '\uFFFC';

function uniqueIdsWithNotes(name: string, entries: any[]) {
  assert.ok(entries.length > 0, `${name} is empty`);
  const seen = new Set<string>();
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'string', `${name}: entry without id`);
    assert.ok(entry.id && !seen.has(entry.id), `${name}: duplicate or empty id ${entry.id}`);
    seen.add(entry.id);
    assert.equal(typeof entry.note, 'string', `${name}/${entry.id}: missing note`);
    assert.ok(entry.note.trim().length > 0, `${name}/${entry.id}: empty note`);
  }
}

test('the editor fixture sections load and every entry has an id and a note', () => {
  for (const name of ['cases', 'edits', 'rows', 'titles', 'titleEdits']) uniqueIdsWithNotes(`editorHtml.${name}`, editorHtml[name]);
  uniqueIdsWithNotes('checklistOps', fixture.checklistOps);
  assert.ok(editorHtml.authoredBody.every((html: unknown) => typeof html === 'string'));
  assert.ok(editorHtml.authoredRow.every((html: unknown) => typeof html === 'string'));
});

test('every case required by the plan is present', () => {
  const html = (editorHtml.cases as any[]).map(c => c.html).join('\n');
  for (const needle of [
    '<h1><span style="font-weight: normal;">x</span></h1>', '<div><ul><li>a</li></ul></div>', '<li>a<br>b</li>', 'stray', '<s>', 'Caff&#232;',
    'inline-note-image-wrap', '<table>', 'target="_blank" rel="noopener"', '<strong>', '<blockquote>', '<pre>', '<code>',
    '<p dir="ltr" style="margin-top:0; margin-bottom:0;">', '<ol start="3">', '<ul><li>1<ul><li>2<ul><li>3<ul><li>4<ul><li>5</li>',
    'First<br><br>Second<div>Third<br>Fourth</div>&nbsp;<div><br></div>',
  ]) assert.ok(html.includes(needle), `missing case containing ${needle}`);
});

test('case expectations are internally consistent', () => {
  for (const c of editorHtml.cases) {
    assert.ok(Array.isArray(c.lines), c.id);
    assert.equal(typeof c.canonical, 'string', c.id);
    assert.equal(typeof c.hasMeaningfulBody, 'boolean', c.id);
    assert.equal(typeof c.browserInnerText, 'boolean', c.id);
    const meaningful = c.lines.some((line: string) => line === EMBED || line.replace(/\u00a0/g, ' ').trim() !== '');
    assert.equal(c.hasMeaningfulBody, meaningful, `${c.id} hasMeaningfulBody`);
    if (c.browserInnerText) assert.ok(!c.lines.includes(EMBED), `${c.id}: innerText cases have no embeds`);
  }
});

test('edit selections point into the recorded text', () => {
  for (const e of editorHtml.edits) {
    assert.equal(e.selection.length, 2, e.id);
    for (const offset of e.selection) assert.ok(offset >= 0 && offset <= e.text.length, `${e.id} selection ${offset}`);
    assert.match(e.action, /^(enter|backspace|bold|italic|underline|h1|h2|normal|bullet|indent|outdent|clear|paste:[\s\S]*)$/, e.id);
    assert.equal(typeof e.expected, 'string', e.id);
  }
  for (const r of editorHtml.rows) {
    const [start, end] = r.edit.selection;
    assert.ok(start <= end && end <= r.text.length, `${r.id} selection`);
    assert.ok(Array.isArray(r.expected) && r.expected.length >= 1, `${r.id} expected rows`);
  }
});

test('nonBlankLines equals the web splitBodyIntoLines over a parsed document', async (t) => {
  let parse5: any;
  try { parse5 = await import('parse5'); } catch { return t.skip('parse5 is not installed'); }
  const adapt = (n: any): LineNode => {
    if (n.nodeName === '#text') return { nodeType: 3, nodeName: '#text', textContent: n.value, childNodes: [] };
    if (n.nodeName.startsWith('#')) return { nodeType: 8, nodeName: n.nodeName, textContent: null, childNodes: [] };
    const className = n.attrs?.find((a: any) => a.name === 'class')?.value ?? '';
    return { nodeType: 1, nodeName: n.nodeName.toUpperCase(), textContent: null, className, outerHTML: parse5.serializeOuter(n),
      getAttribute: (name: string) => n.attrs?.find((attribute: any) => attribute.name === name)?.value ?? null,
      get childNodes() { return (n.childNodes || []).map(adapt); } } as LineNode;
  };
  const bodyOf = (html: string) => parse5.parse(html).childNodes.find((c: any) => c.nodeName === 'html').childNodes.find((c: any) => c.nodeName === 'body');
  for (const c of editorHtml.cases) {
    if (!('nonBlankLines' in c)) continue;
    assert.deepEqual(splitBodyIntoLines(adapt(bodyOf(c.html))).lines, c.nonBlankLines, c.id);
  }
});

test('checklist op fixtures carry rows with the full shape', () => {
  const names = new Set(['setIndent', 'toggleDone', 'moveBefore', 'split', 'merge', 'remove', 'show', 'hide']);
  for (const op of fixture.checklistOps) {
    assert.ok(names.has(op.op), op.id);
    assert.ok(Array.isArray(op.items), op.id);
    for (const row of op.items) {
      assert.ok(Number.isInteger(row.id) && typeof row.done === 'boolean' && Number.isInteger(row.indentLevel) && 'data' in row, `${op.id} row`);
    }
    assert.ok('expected' in op && 'args' in op, op.id);
  }
});
