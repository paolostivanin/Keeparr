// node --test src/app/utils/note-color.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  NOTE_DARK_COLORS, darkIllustrationColor, darkNoteColor, noteColorToHex, noteLinkColor, noteSurfaceVars, noteTextColor,
} from './note-color.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../test-fixtures/native-contract.json', import.meta.url), 'utf8'));
const colors = fixture.noteColors;
const bgColorsSource = readFileSync(new URL('../interfaces/tooltip.ts', import.meta.url), 'utf8').match(/export enum bgColors \{([^}]*)\}/)![1];
const storedSwatches = [...bgColorsSource.matchAll(/'(#[0-9a-f]{6})'/g)].map(match => match[1]);

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

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

test('every stored swatch has a dark render value and the dark swatches map to themselves', () => {
  assert.equal(storedSwatches.length, 35);
  assert.equal(Object.keys(NOTE_DARK_COLORS).length, 20);
  for (const light of storedSwatches) {
    const dark = darkNoteColor(light);
    if (light in NOTE_DARK_COLORS) assert.equal(dark, NOTE_DARK_COLORS[light]);
    else assert.equal(dark, light, `${light} is already dark`);
    assert.ok(luminance(dark) <= 0.10, `${light} -> ${dark} luminance`);
    assert.ok(contrast(dark, '#e8eaed') >= 4.5, `${light} -> ${dark} contrast`);
  }
  assert.equal(darkNoteColor(''), '');
});

test('darkNoteColor pins its generated samples and leaves unparseable input alone', () => {
  assert.equal(darkNoteColor('#ffffff'), '#404040');
  assert.equal(darkNoteColor('#f28b82'), '#5a2a26');
  assert.equal(darkNoteColor('#fbbc04'), '#5f4f21');
  assert.equal(darkNoteColor('#ff0000'), '#602020');
  assert.equal(darkNoteColor('#0000ff'), '#0000ff');
  assert.equal(darkNoteColor('#5b0000'), '#5b0000');
  assert.equal(darkNoteColor('#FFF'), '#404040');
  assert.equal(darkNoteColor('rgb(203, 240, 248)'), '#2d555e');
  assert.equal(darkNoteColor('#CBF0F8FF'), '#2d555e');
  assert.equal(darkNoteColor('transparent'), 'transparent');
});

test('text and link colors follow the contrast rule', () => {
  assert.equal(noteTextColor('#fff8b8'), '#202124');
  assert.equal(noteTextColor('#7c4a03'), '#e8eaed');
  assert.equal(noteTextColor('', false), '#202124');
  assert.equal(noteTextColor('', true), '#e8eaed');
  assert.equal(noteLinkColor('#fff8b8'), '#1a73e8');
  assert.equal(noteLinkColor('#7c4a03'), '#8ab4f8');
  for (const light of storedSwatches) {
    const dark = darkNoteColor(light);
    assert.ok(contrast(light, noteTextColor(light)) >= 4.5, `${light} text in the light theme`);
    assert.ok(contrast(dark, noteTextColor(dark, true)) >= 4.5, `${dark} text in the dark theme`);
    // The fixed link colors (#1a73e8 / #8ab4f8) cannot reach 4.5:1 on every pastel (worst: Lavender 2.4:1 light,
    // Cream 3.5:1 dark), so only a floor is asserted. Links are also underlined. See docs/note-content-contract.md.
    assert.ok(contrast(light, noteLinkColor(light)) >= 2.4, `${light} link in the light theme`);
    assert.ok(contrast(dark, noteLinkColor(dark, true)) >= 3.4, `${dark} link in the dark theme`);
  }
});

test('darkIllustrationColor lowers lightness and caps saturation', () => {
  assert.equal(darkIllustrationColor('#fff8d9'), '#362f14');
  assert.equal(darkIllustrationColor('#ffffff'), '#1a1a1a');
  assert.equal(darkIllustrationColor('nope'), 'nope');
});

test('noteSurfaceVars exposes light and dark variables', () => {
  const cream = noteSurfaceVars('#fff8b8', '');
  assert.deepEqual(
    [cream['--note-bg'], cream['--note-bg-dark'], cream['--note-fg'], cream['--note-fg-dark'], cream['--note-link'], cream['--note-link-dark']],
    ['#fff8b8', '#7c4a03', '#202124', '#e8eaed', '#1a73e8', '#8ab4f8']);
  assert.equal(cream['--note-bg-image'], 'none');
  const none = noteSurfaceVars('', '');
  assert.equal(none['--note-bg'], '');
  assert.equal(none['--note-fg'], '#202124');
  assert.equal(none['--note-fg-dark'], '#e8eaed');
  const image = noteSurfaceVars('', '/assets/images/backgrounds/groceries.svg');
  assert.equal(image['--note-bg-image'], 'url("/assets/images/backgrounds/groceries.svg")');
  assert.equal(image['--note-bg-image-dark'], 'url("/assets/images/backgrounds/groceries_dark.svg")');
  assert.equal(image['--note-fg'], '#202124');
  assert.equal(image['--note-fg-dark'], '#e8eaed');
  // Every stored form of the same illustration maps to the same dark file.
  for (const stored of ['url(/assets/images/backgrounds/groceries.svg)', 'url("/assets/images/backgrounds/groceries.svg")', "url('/assets/images/backgrounds/groceries.svg')"]) {
    assert.equal(noteSurfaceVars('', stored)['--note-bg-image-dark'], 'url("/assets/images/backgrounds/groceries_dark.svg")', stored);
  }
  const origin = noteSurfaceVars('', 'url("http://localhost:4200/assets/images/backgrounds/gym.svg")');
  assert.equal(origin['--note-bg-image'], 'url("http://localhost:4200/assets/images/backgrounds/gym.svg")');
  assert.equal(origin['--note-bg-image-dark'], 'url("http://localhost:4200/assets/images/backgrounds/gym_dark.svg")');
  // Unknown values are kept as they are in both themes.
  assert.equal(noteSurfaceVars('', 'url(x.svg)')['--note-bg-image-dark'], 'url("x.svg")');
  assert.equal(noteSurfaceVars('', '/assets/images/backgrounds/image-1.svg')['--note-bg-image-dark'], 'url("/assets/images/backgrounds/image-1.svg")');
  // An image picked after a color keeps the color underneath.
  const both = noteSurfaceVars('#fff8b8', 'url(/assets/images/backgrounds/groceries.svg)');
  assert.deepEqual([both['--note-bg'], both['--note-bg-dark'], both['--note-fg'], both['--note-fg-dark']], ['#fff8b8', '#7c4a03', '#202124', '#e8eaed']);
});

test('fixture noteColors matches the palette and the reference code', () => {
  assert.deepEqual(colors.palette.map((p: any) => p.light), storedSwatches);
  for (const { light, dark } of colors.palette) assert.equal(darkNoteColor(light), dark);
  for (const { input, dark } of colors.fallback) assert.equal(darkNoteColor(input), dark, input);
  for (const { background, dark, text } of colors.text) assert.equal(noteTextColor(background, dark ?? false), text, background);
  for (const { background, dark, link } of colors.link) assert.equal(noteLinkColor(background, dark ?? false), link, background);
  for (const { input, dark } of colors.illustration) assert.equal(darkIllustrationColor(input), dark, input);
  assert.equal(colors.darkThreshold, 0.12);
  assert.equal(colors.maxDarkLuminance, 0.10);
});
