/**
 * Normalizes a note background color to lowercase `#rrggbb`.
 * Colors read back from the DOM (`element.style.backgroundColor`) come out as
 * `rgb(r, g, b)`, which native clients can't parse, so always save hex.
 * Unrecognized values are returned unchanged.
 */
export function noteColorToHex(color: string): string {
  const value = (color || '').trim()
  if (!value) return ''
  const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)$/i)
  if (rgb) {
    return '#' + rgb.slice(1, 4).map(channel => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('')
  }
  if (/^#[a-f\d]{6}$/i.test(value)) return value.toLowerCase()
  return value
}

/*
 * Dark note colors. Stored `bgColor` values are data and never change; the dark
 * variant exists only at render time. Spec: PLAN.md section 6 and
 * docs/note-content-contract.md. The Android client implements the same rules and
 * is checked against `test-fixtures/native-contract.json` (`noteColors`).
 */

/** Stored (light) pastel -> dark render value. Keys are the palette hex values in `bgColors`. */
export const NOTE_DARK_COLORS: Readonly<Record<string, string>> = {
  '#cbf0f8': '#2d555e', // Aqua
  '#fddcbb': '#5e4022', // Apricot
  '#fdcfe8': '#5b2245', // Blush
  '#fff8b8': '#7c4a03', // Cream
  '#d7aefb': '#42275e', // Lavender
  '#fef7cc': '#5e5621', // Lemon
  '#e8d7ff': '#3b2060', // Lilac
  '#ccff90': '#345920', // Mint
  '#ffd8b5': '#603e20', // Peach
  '#f8c7c0': '#592d26', // Rose
  '#e6f4d7': '#40522e', // Sage
  '#d2e3fc': '#243a5c', // Sky
  '#ffb74d': '#604620', // Creamsicle
  '#abc4ff': '#203360', // Cornflower
  '#ffc2d1': '#602030', // Flamingo
  '#ffab91': '#602f20', // Coral
  '#a7ffeb': '#16504b', // Turquoise
  '#e6ee9c': '#525629', // Lime
  '#efe0c8': '#51442e', // Sand
  '#c5cae9': '#31354e', // Periwinkle
};

export const NOTE_TEXT_LIGHT_THEME = '#202124';
export const NOTE_TEXT_DARK_THEME = '#e8eaed';
export const NOTE_LINK_LIGHT_THEME = '#1a73e8';
export const NOTE_LINK_DARK_THEME = '#8ab4f8';
/** Colors at or below this luminance are already dark and render unchanged. */
export const NOTE_DARK_THRESHOLD = 0.12;
/** The generated dark variant is darkened until it reaches this luminance. */
export const NOTE_MAX_DARK_LUMINANCE = 0.10;

type Rgb = [number, number, number];

/** Parses 3-, 6- or 8-digit hex and rgb()/rgba() into 0..255 channels; null when unrecognized. */
function parseColor(value: string): Rgb | null {
  const text = (value || '').trim();
  const hex = text.match(/^#([a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) digits = digits.split('').map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
  }
  const rgb = text.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)$/i);
  if (rgb) return [1, 2, 3].map(i => Math.min(255, Number(rgb[i]))) as Rgb;
  return null;
}

function toHex(rgb: Rgb): string {
  return '#' + rgb.map(channel => channel.toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance, 0..1. */
function luminance([r, g, b]: Rgb): number {
  const lin = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d + 6) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

/** Channels are rounded with Math.round (half up) so Kotlin can match exactly. */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h / 60) % 6;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector];
  return [r + m, g + m, b + m].map(v => Math.round(v * 255)) as Rgb;
}

/**
 * The dark render value for a stored note color. Palette pastels use the table,
 * colors that are already dark stay as they are, anything else is desaturated and
 * darkened. Empty or unparseable input is returned unchanged.
 */
export function darkNoteColor(stored: string): string {
  const rgb = parseColor(stored);
  if (!rgb) return stored;
  const hex = toHex(rgb);
  const known = NOTE_DARK_COLORS[hex];
  if (known) return known;
  if (luminance(rgb) <= NOTE_DARK_THRESHOLD) return hex;
  const [h, s] = rgbToHsl(rgb);
  const saturation = Math.min(0.5 * s, 0.6);
  let lightness = 25; // integer hundredths
  let out = hslToRgb(h, saturation, lightness / 100);
  while (luminance(out) > NOTE_MAX_DARK_LUMINANCE && lightness > 15) {
    lightness -= 1;
    out = hslToRgb(h, saturation, lightness / 100);
  }
  return toHex(out);
}

/**
 * Text color for a displayed background: whichever theme text color contrasts more
 * (ties go to the light-theme color). With no usable color it is the theme's own
 * text color, so `dark` says which theme is active.
 */
export function noteTextColor(displayedBg: string, dark = false): string {
  const rgb = parseColor(displayedBg);
  if (!rgb) return dark ? NOTE_TEXT_DARK_THEME : NOTE_TEXT_LIGHT_THEME;
  const bg = luminance(rgb);
  const onLight = contrast(bg, luminance(parseColor(NOTE_TEXT_LIGHT_THEME)!));
  const onDark = contrast(bg, luminance(parseColor(NOTE_TEXT_DARK_THEME)!));
  return onDark > onLight ? NOTE_TEXT_DARK_THEME : NOTE_TEXT_LIGHT_THEME;
}

/** Link color that matches `noteTextColor` for the same background. */
export function noteLinkColor(displayedBg: string, dark = false): string {
  return noteTextColor(displayedBg, dark) === NOTE_TEXT_LIGHT_THEME ? NOTE_LINK_LIGHT_THEME : NOTE_LINK_DARK_THEME;
}

/** Dark-theme counterpart of an illustration fill/stroke: HSL(h, min(s, 0.45), 0.10 + (1 - l) * 0.6). */
export function darkIllustrationColor(hex: string): string {
  const rgb = parseColor(hex);
  if (!rgb) return hex;
  const [h, s, l] = rgbToHsl(rgb);
  return toHex(hslToRgb(h, Math.min(s, 0.45), 0.10 + (1 - l) * 0.6));
}

const BACKGROUND_NAMES = 'groceries|tasks|movies|cafes|romantic|gym|recipes|travel|study|ideas|meetings|budget';
const BACKGROUND_IMAGE = new RegExp(`^(.*/assets/images/backgrounds/)(${BACKGROUND_NAMES})\\.svg$`);

function cssUrl(path: string): string {
  return `url("${path.replace(/["\\\n]/g, encodeURIComponent)}")`;
}

/**
 * The path inside a stored `bgImage`: `url("...")`, `url(...)` and a bare path are accepted
 * (the web has stored all three; the readback form includes the page origin). '' for none.
 */
export function noteBgImagePath(bgImage: string): string {
  const value = (bgImage || '').trim();
  const wrapped = value.match(/^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)$/i);
  return wrapped ? (wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? '').trim() : value;
}

/** The dark-theme counterpart path of one of the 12 bundled illustrations, else the path itself. */
export function darkNoteBgImagePath(path: string): string {
  const known = path.match(BACKGROUND_IMAGE);
  return known ? `${known[1]}${known[2]}_dark.svg` : path;
}

/**
 * CSS custom properties for a note surface. `bgColor`/`bgImage` are the stored
 * values. Light variables render under the light theme, `-dark` under the dark
 * theme (`.note-surface` in styles.scss picks). An unset color yields '' for the
 * `--note-bg*` variables (remove the property); an unset image yields 'none'.
 */
export function noteSurfaceVars(bgColor: string, bgImage: string): Record<string, string> {
  const path = noteBgImagePath(bgImage);
  const hasImage = !!path;
  // A note can hold both (an image picked after a color); the color then shows through the illustration.
  const light = parseColor(bgColor) ? toHex(parseColor(bgColor)!) : (bgColor || '').trim();
  const dark = darkNoteColor(light);
  return {
    '--note-bg': light,
    '--note-bg-dark': dark,
    '--note-fg': noteTextColor(light, false),
    '--note-fg-dark': noteTextColor(dark, true),
    '--note-link': noteLinkColor(light, false),
    '--note-link-dark': noteLinkColor(dark, true),
    '--note-bg-image': hasImage ? cssUrl(path) : 'none',
    '--note-bg-image-dark': hasImage ? cssUrl(darkNoteBgImagePath(path)) : 'none',
  };
}
