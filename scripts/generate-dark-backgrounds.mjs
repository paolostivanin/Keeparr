#!/usr/bin/env node
// Writes the dark-theme copies of the 12 bundled note background illustrations:
// src/assets/images/backgrounds/<name>_dark.svg and <name>_dark_ph.svg (the picker thumbnail),
// derived from <name>.svg / <name>_ph.svg by mapping every fill, stroke and stop color
// through darkIllustrationColor (src/app/utils/note-color.ts). The outputs are committed;
// the drift test (src/app/utils/dark-backgrounds.test.ts) fails when they differ from this script.
// Run: node scripts/generate-dark-backgrounds.mjs     Add --check to only verify.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { darkIllustrationColor } from '../src/app/utils/note-color.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
export const BACKGROUND_DIR = root + 'src/assets/images/backgrounds/';
export const BACKGROUND_NAMES = ['groceries', 'tasks', 'movies', 'cafes', 'romantic', 'gym', 'recipes', 'travel', 'study', 'ideas', 'meetings', 'budget'];

const COLOR_PROPERTY = '(fill|stroke|stop-color|flood-color|lighting-color)';
const HEX = '#[0-9a-fA-F]{3,8}';

/** Darkens every hex color in a color attribute (`fill="#fff"`) or inline declaration (`fill:#fff`). */
export function darkenSvg(svg) {
  const convert = hex => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? darkIllustrationColor(hex.toLowerCase()) : hex);
  return svg
    .replace(new RegExp(`\\b${COLOR_PROPERTY}="(${HEX})"`, 'g'), (_m, property, hex) => `${property}="${convert(hex)}"`)
    .replace(new RegExp(`\\b${COLOR_PROPERTY}:\\s*(${HEX})`, 'g'), (_m, property, hex) => `${property}:${convert(hex)}`);
}

/** Every generated file: name -> content. */
export function darkBackgrounds(read = path => readFileSync(path, 'utf8')) {
  const files = new Map();
  for (const name of BACKGROUND_NAMES) {
    for (const suffix of ['', '_ph']) {
      files.set(`${name}_dark${suffix}.svg`, darkenSvg(read(`${BACKGROUND_DIR}${name}${suffix}.svg`)));
    }
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = darkBackgrounds();
  const stale = [...files].filter(([file, content]) => !existsSync(BACKGROUND_DIR + file) || readFileSync(BACKGROUND_DIR + file, 'utf8') !== content);
  if (process.argv.includes('--check')) {
    if (stale.length) {
      console.error(`stale dark backgrounds (run node scripts/generate-dark-backgrounds.mjs): ${stale.map(([file]) => file).join(', ')}`);
      process.exit(1);
    }
  } else {
    for (const [file, content] of stale) writeFileSync(BACKGROUND_DIR + file, content);
    console.log(`dark backgrounds: ${stale.length} of ${files.size} files written`);
  }
}
