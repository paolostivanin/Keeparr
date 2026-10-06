// node --test src/app/utils/checklist-conversion.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canHideCheckboxes, checkBoxesToBodyHtml, escapeHtml, linesToCheckBoxes, splitBodyIntoLines, type LineNode } from './checklist-conversion.ts';

const text = (value: string): LineNode => ({ nodeType: 3, nodeName: '#text', textContent: value, childNodes: [] });
const el = (name: string, children: LineNode[] = [], extra: Partial<LineNode> = {}): LineNode =>
  ({ nodeType: 1, nodeName: name.toUpperCase(), textContent: null, childNodes: children, ...extra });
const root = (...children: LineNode[]) => el('div', children);

test('splitBodyIntoLines breaks on br and block elements and skips blank lines', () => {
  const body = root(text('First'), el('br'), el('br'), text('Second'), el('div', [text('Third'), el('br'), text('Fourth')]),
    text(' '), el('div', [el('br')]));
  assert.deepEqual(splitBodyIntoLines(body).lines, ['First', 'Second', 'Third', 'Fourth']);
});

test('splitBodyIntoLines treats newlines between blocks as whitespace and keeps inline text together', () => {
  const body = root(el('p', [text('Milk '), el('b', [text('and')]), text(' eggs')]), text('\n'), el('p', [text('Bread')]), text('\n'));
  assert.deepEqual(splitBodyIntoLines(body).lines, ['Milk and eggs', 'Bread']);
});

test('splitBodyIntoLines keeps images and link previews in the body instead of dropping them', () => {
  const body = root(text('Line'), el('img', [], { outerHTML: '<img src="a.png">' }),
    el('div', [], { className: 'editor-link-preview-slot', outerHTML: '<div class="editor-link-preview-slot"></div>' }));
  const { lines, leftoverHtml } = splitBodyIntoLines(body);
  assert.deepEqual(lines, ['Line']);
  assert.equal(leftoverHtml, '<img src="a.png"><div class="editor-link-preview-slot"></div>');
});

test('linesToCheckBoxes escapes text and continues after the highest existing id', () => {
  const items = linesToCheckBoxes(['a < b', 'Tom & Jerry'], [{ id: 4, done: true, data: 'old' }, { id: -1, done: false, data: '' }]);
  assert.deepEqual(items, [
    { done: false, data: 'a &lt; b', id: 5, indentLevel: 0 },
    { done: false, data: 'Tom &amp; Jerry', id: 6, indentLevel: 0 },
  ]);
  assert.equal(linesToCheckBoxes(['x'])[0].id, 0);
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
});

test('checkBoxesToBodyHtml keeps unchecked items in order and drops checked and blank ones', () => {
  const html = checkBoxesToBodyHtml([
    { id: 1, done: true, data: 'Done' },
    { id: 2, done: false, data: 'Milk &amp; eggs', indentLevel: 2 },
    { id: 3, done: false, data: '<br>' },
    { id: 4, done: false, data: '&nbsp;' },
    { id: 5, done: false, data: 'Bread' },
  ]);
  assert.equal(html, '<div>Milk &amp; eggs</div><div>Bread</div>');
});

test('canHideCheckboxes refuses structured unchecked items but ignores checked ones', () => {
  assert.equal(canHideCheckboxes([{ id: 1, done: false, data: { rich: true } }]), false);
  assert.equal(canHideCheckboxes([{ id: 1, done: true, data: { rich: true } }, { id: 2, done: false, data: 'ok' }]), true);
});
