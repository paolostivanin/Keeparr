// node --import ./scripts/resolve-ts-imports.mjs --test src/app/utils/checklist-model.test.ts
// Replays the shared `checklistOps` fixtures (test-fixtures/native-contract.json, docs/note-content-contract.md section 6.4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { LineNode } from './checklist-conversion.ts';
import {
  hideChecklistToBody, mergeChecklistRow, moveChecklistBefore, removeChecklistRow, setChecklistIndent, showChecklistFromBody,
  splitChecklistRow, toggleChecklistDone,
} from './checklist-model.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../test-fixtures/native-contract.json', import.meta.url), 'utf8'));
const ops: any[] = fixture.checklistOps;

let parse5: any;
try { parse5 = await import('parse5'); } catch { /* the `show` ops are skipped without it */ }

/** parse5 node as the tree-like input `splitBodyIntoLines` expects. */
function adapt(node: any): LineNode {
  if (node.nodeName === '#text') return { nodeType: 3, nodeName: '#text', textContent: node.value, childNodes: [] };
  if (node.nodeName.startsWith('#')) return { nodeType: 8, nodeName: node.nodeName, textContent: null, childNodes: [] };
  const attribute = (name: string) => node.attrs?.find((a: any) => a.name === name);
  return {
    nodeType: 1, nodeName: node.nodeName.toUpperCase(), textContent: null, className: attribute('class')?.value ?? '',
    outerHTML: parse5.serializeOuter(node), hasAttribute: (name: string) => !!attribute(name),
    get childNodes() { return (node.childNodes || []).map(adapt); },
  } as LineNode;
}
const bodyNode = (html: string) => adapt(parse5.parse(html).childNodes.find((c: any) => c.nodeName === 'html').childNodes.find((c: any) => c.nodeName === 'body'));

function run(op: any) {
  const { items, args } = op;
  switch (op.op) {
    case 'setIndent': return setChecklistIndent(items, args.id, args.indentLevel);
    case 'toggleDone': return toggleChecklistDone(items, args.id);
    case 'moveBefore': return moveChecklistBefore(items, args.id, args.beforeId);
    case 'split': return splitChecklistRow(items, args.id, args.left, args.right);
    case 'merge': return mergeChecklistRow(items, args.id, args.visibleIds);
    case 'remove': return removeChecklistRow(items, args.id);
    case 'show': return showChecklistFromBody(items, bodyNode(args.body));
    case 'hide': return hideChecklistToBody(items, args.body);
    default: throw new Error(`unknown op ${op.op}`);
  }
}

for (const op of ops) {
  test(`checklistOps ${op.id}`, t => {
    if (op.op === 'show' && !parse5) return t.skip('parse5 is not installed');
    const before = JSON.stringify(op.items);
    assert.deepEqual(run(op), op.expected, op.note);
    assert.equal(JSON.stringify(op.items), before, 'ops never mutate their input');
  });
}

test('every checklist op of the contract is covered by a fixture', () => {
  assert.deepEqual([...new Set(ops.map(op => op.op))].sort(), ['hide', 'merge', 'moveBefore', 'remove', 'setIndent', 'show', 'split', 'toggleDone']);
});

test('split and merge round-trip a row', () => {
  const rows = [{ id: 1, done: false, data: '<b>ab</b>cd', indentLevel: 1 }];
  const split = splitChecklistRow(rows, 1, '<b>a</b>', '<b>b</b>cd')!;
  const merged = mergeChecklistRow(split, split[1].id)!;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].data, '<b>a</b><b>b</b>cd');
  assert.equal(merged[0].indentLevel, 1);
});
