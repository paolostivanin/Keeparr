// node --test src/app/utils/note-color.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteColorToHex } from './note-color.ts';

test('converts DOM rgb() colors to hex', () => {
  assert.equal(noteColorToHex('rgb(203, 240, 248)'), '#cbf0f8');
  assert.equal(noteColorToHex('rgb(203,240,248)'), '#cbf0f8');
  assert.equal(noteColorToHex('rgba(15, 23, 42, 0.5)'), '#0f172a');
  assert.equal(noteColorToHex('rgb(0, 0, 0)'), '#000000');
});

test('lowercases hex and keeps empty as no color', () => {
  assert.equal(noteColorToHex('#CBF0F8'), '#cbf0f8');
  assert.equal(noteColorToHex('#cbf0f8'), '#cbf0f8');
  assert.equal(noteColorToHex(''), '');
  assert.equal(noteColorToHex('  '), '');
});

test('passes unknown values through unchanged', () => {
  assert.equal(noteColorToHex('transparent'), 'transparent');
  assert.equal(noteColorToHex('#abc'), '#abc');
});

test('palette colors round-trip through their DOM rgb() form', () => {
  for (const hex of ['#cbf0f8', '#ffab91', '#c5cae9', '#0f172a', '#282a5c', '#144a5c']) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    assert.equal(noteColorToHex(`rgb(${r}, ${g}, ${b})`), hex);
  }
});
