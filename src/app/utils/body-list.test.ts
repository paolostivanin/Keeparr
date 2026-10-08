// node --test src/app/utils/body-list.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_BODY_LIST_LEVELS, canIndentBodyList, canOutdentBodyList, listDepth } from './body-list.ts';

const el = (tagName: string, parentElement: any = null) => ({ tagName, parentElement });

test('limit is four levels', () => assert.equal(MAX_BODY_LIST_LEVELS, 4));

test('listDepth counts enclosing lists up to the root', () => {
  const root = el('DIV');
  const ul1 = el('UL', root), li1 = el('LI', ul1);
  const ul2 = el('UL', li1), li2 = el('LI', ul2);
  assert.equal(listDepth(root, root), 0);
  assert.equal(listDepth(el('DIV', root), root), 0);
  assert.equal(listDepth(li1, root), 1);
  assert.equal(listDepth(li2, root), 2);
  assert.equal(listDepth(null, root), 0);
});

test('indent is allowed only inside a list and below level four', () => {
  assert.equal(canIndentBodyList(0), false);
  assert.equal(canIndentBodyList(1), true);
  assert.equal(canIndentBodyList(3), true);
  assert.equal(canIndentBodyList(4), false);
});

test('outdent is allowed only inside a list', () => {
  assert.equal(canOutdentBodyList(0), false);
  assert.equal(canOutdentBodyList(4), true);
});
