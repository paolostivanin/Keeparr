#!/usr/bin/env node
// Regenerates the `noteColors` section of test-fixtures/native-contract.json from the
// TypeScript reference (src/app/utils/note-color.ts) and the palette in
// src/app/interfaces/tooltip.ts. Run: node scripts/generate-note-color-fixtures.mjs
// Add --check to fail when the committed fixture differs from the regenerated one.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  NOTE_DARK_THRESHOLD, NOTE_MAX_DARK_LUMINANCE, darkIllustrationColor, darkNoteColor, noteLinkColor, noteTextColor,
} from '../src/app/utils/note-color.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURE_PATH = root + 'test-fixtures/native-contract.json';

/** Fixture layout: objects down to depth 1 are expanded, rows of arrays of objects take one line each. */
/** Invisible characters (U+00A0, U+FFFC) are written as \\u escapes so the fixture stays reviewable. */
export function formatFixture(value, depth = 0, indent = '') {
  const inline = v => Array.isArray(v) ? `[${v.map(inline).join(', ')}]`
    : v && typeof v === 'object' ? (Object.keys(v).length ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}')
    : JSON.stringify(v).replace(/[\u00a0\ufffc]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const next = indent + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (!value.some(item => item && typeof item === 'object')) return inline(value);
    return `[\n${value.map(item => next + (depth < 1 && item && typeof item === 'object' && !Array.isArray(item) ? formatFixture(item, depth + 1, next) : inline(item))).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object' && depth < 2) {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${formatFixture(v, depth + 1, next)}`).join(',\n')}\n${indent}}`;
  }
  return inline(value);
}

export function buildNoteColors() {
  const source = readFileSync(root + 'src/app/interfaces/tooltip.ts', 'utf8');
  const body = source.match(/export enum bgColors \{([^}]*)\}/)[1];
  const swatches = [...body.matchAll(/^\s*(\w+)\s*=\s*'(#[0-9a-f]{6})'/gim)]
    .map(([, name, light]) => ({ name: name[0].toUpperCase() + name.slice(1), light }));
  const palette = swatches.map(({ name, light }) => ({ name, light, dark: darkNoteColor(light) }));

  const fallbackInputs = ['#ffffff', '#fff', '#FFFFFF', '#f28b82', '#fbbc04', '#ff0000', '#00ff00', '#0000ff', '#808080', '#cccccc',
    '#5b0000', '#000000', '#1a73e8', 'rgb(255, 0, 0)', 'rgba(242, 139, 130, 0.5)', '#ff000080', '#F28B82', '', 'transparent', 'not-a-color'];
  const fallback = fallbackInputs.map(input => ({ input, dark: darkNoteColor(input) }));

  // Displayed backgrounds: pastels in the light theme, the dark variants (and the dark swatches) in the dark theme.
  const displayed = [...new Set([...palette.map(p => p.light), ...palette.map(p => p.dark), '#ffffff', '#000000', '#808080', '#767676', '#777777'])];
  const text = displayed.map(background => ({ background, text: noteTextColor(background) }));
  const link = displayed.map(background => ({ background, link: noteLinkColor(background) }));
  for (const dark of [false, true]) {
    for (const background of ['', 'not-a-color']) {
      text.push({ background, dark, text: noteTextColor(background, dark) });
      link.push({ background, dark, link: noteLinkColor(background, dark) });
    }
  }

  const illustration = ['#fff8d9', '#ffffff', '#000000', '#ff0000', '#3a7bd5', '#cccccc', '#fff', '#e6f4d7', '#2d2d2d']
    .map(input => ({ input, dark: darkIllustrationColor(input) }));

  return { palette, fallback, text, link, illustration, darkThreshold: NOTE_DARK_THRESHOLD, maxDarkLuminance: NOTE_MAX_DARK_LUMINANCE };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  fixture.noteColors = buildNoteColors();
  const output = formatFixture(fixture) + '\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(FIXTURE_PATH, 'utf8') !== output) {
      console.error('test-fixtures/native-contract.json is stale: run node scripts/generate-note-color-fixtures.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(FIXTURE_PATH, output);
    console.log(`noteColors: ${fixture.noteColors.palette.length} swatches written`);
  }
}
