// node --test src/app/utils/dark-backgrounds.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
// @ts-expect-error plain ES module without declarations
import { BACKGROUND_DIR, BACKGROUND_NAMES, darkBackgrounds, darkenSvg } from '../../../scripts/generate-dark-backgrounds.mjs';
import { darkIllustrationColor, darkNoteBgImagePath, noteSurfaceVars } from './note-color.ts';

const bgImagesSource = readFileSync(new URL('../interfaces/tooltip.ts', import.meta.url), 'utf8').match(/export enum bgImages \{([^}]*)\}/)![1];

test('the picker offers exactly the illustrations that have dark copies', () => {
  const offered = [...bgImagesSource.matchAll(/'\/assets\/images\/backgrounds\/([a-z-]+)\.svg'/g)].map(match => match[1]);
  assert.deepEqual([...offered].sort(), [...BACKGROUND_NAMES].sort());
});

test('committed *_dark.svg files equal the regenerated output (run node scripts/generate-dark-backgrounds.mjs)', () => {
  const files: Map<string, string> = darkBackgrounds();
  assert.equal(files.size, BACKGROUND_NAMES.length * 2);
  for (const [file, content] of files) {
    assert.ok(existsSync(BACKGROUND_DIR + file), `${file} is missing`);
    assert.equal(readFileSync(BACKGROUND_DIR + file, 'utf8'), content, `${file} is stale`);
  }
});

test('darkening changes colors only', () => {
  const light = '<svg viewBox="0 0 8 8"><rect fill="#fff8d9" stroke="#abc" stroke-width="3"/><path fill="none" d="M0 0h8" style="fill:#e6f4d7"/><stop stop-color="#ffffff"/></svg>';
  const dark = darkenSvg(light);
  assert.equal(dark, `<svg viewBox="0 0 8 8"><rect fill="${darkIllustrationColor('#fff8d9')}" stroke="${darkIllustrationColor('#abc')}" stroke-width="3"/><path fill="none" d="M0 0h8" style="fill:${darkIllustrationColor('#e6f4d7')}"/><stop stop-color="${darkIllustrationColor('#ffffff')}"/></svg>`);
  assert.equal(darkenSvg('<g fill="url(#a)" opacity="0.5"/>'), '<g fill="url(#a)" opacity="0.5"/>');
});

test('every generated illustration is darker than its source', () => {
  for (const [file, content] of darkBackgrounds() as Map<string, string>) {
    const source = readFileSync(BACKGROUND_DIR + file.replace('_dark', ''), 'utf8');
    const lightness = (svg: string) => {
      const colors = [...svg.matchAll(/(?:fill|stroke|stop-color)="#([0-9a-f]{6})"/gi)].map(match => match[1]);
      return colors.reduce((sum, hex) => sum + [0, 2, 4].reduce((acc, i) => acc + parseInt(hex.slice(i, i + 2), 16), 0), 0) / Math.max(colors.length, 1);
    };
    assert.ok(lightness(content) < lightness(source) - 100, `${file} is not clearly darker`);
  }
});

test('noteSurfaceVars points the dark theme at the generated files for every stored form', () => {
  for (const name of BACKGROUND_NAMES as string[]) {
    const dark = `url("/assets/images/backgrounds/${name}_dark.svg")`;
    assert.ok(existsSync(`${BACKGROUND_DIR}${name}_dark.svg`));
    for (const stored of [`url(/assets/images/backgrounds/${name}.svg)`, `url("/assets/images/backgrounds/${name}.svg")`, `/assets/images/backgrounds/${name}.svg`]) {
      const vars = noteSurfaceVars('', stored);
      assert.equal(vars['--note-bg-image-dark'], dark, stored);
      assert.equal(vars['--note-bg-image'], `url("/assets/images/backgrounds/${name}.svg")`);
    }
  }
  assert.equal(darkNoteBgImagePath('/assets/images/backgrounds/image-1.svg'), '/assets/images/backgrounds/image-1.svg');
});
