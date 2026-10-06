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
