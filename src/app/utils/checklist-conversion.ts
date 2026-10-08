/**
 * Keep-style "Show checkboxes" / "Hide checkboxes": converts between a note body and checklist items.
 * Works on any node-like tree so it can be tested without a DOM.
 */
export interface LineNode {
  nodeType: number
  nodeName: string
  textContent: string | null
  childNodes: ArrayLike<LineNode>
  className?: unknown
  outerHTML?: string
}

export interface ChecklistItem {
  done: boolean
  data: any
  id: number
  indentLevel?: number
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Content that is not text (images, link previews) cannot become a checklist item and stays in the body. */
function isKeeparrAsBody(node: LineNode): boolean {
  const className = typeof node.className === 'string' ? node.className : ''
  return node.nodeName === 'IMG' || className.split(/\s+/).includes('editor-link-preview-slot')
}

/** One entry per visible line: <br> and block elements end a line, blank lines are skipped. */
export function splitBodyIntoLines(root: LineNode): { lines: string[]; leftoverHtml: string } {
  const lines: string[] = []
  const leftover: string[] = []
  let current = ''
  const flush = () => {
    const text = current.replace(/\u00a0/g, ' ').trim()
    if (text) lines.push(text)
    current = ''
  }
  const walk = (node: LineNode) => {
    if (node.nodeType === TEXT_NODE) {
      current += (node.textContent || '').replace(/\s+/g, ' ')
    } else if (node.nodeType === ELEMENT_NODE) {
      if (isKeeparrAsBody(node)) {
        if (node.outerHTML) leftover.push(node.outerHTML)
      } else if (node.nodeName === 'BR') {
        flush()
      } else {
        const block = BLOCK_TAGS.has(node.nodeName)
        if (block) flush()
        Array.from(node.childNodes).forEach(walk)
        if (block) flush()
      }
    }
  }
  Array.from(root.childNodes).forEach(walk)
  flush()
  return { lines, leftoverHtml: leftover.join('') }
}

/** Unchecked items, one per line; ids continue after the highest existing id like the editor's own "add item". */
export function linesToCheckBoxes(lines: string[], existing: ChecklistItem[] = []): ChecklistItem[] {
  const numericIds = existing.map(item => Number(item.id)).filter(id => Number.isSafeInteger(id) && id >= 0)
  const firstId = (numericIds.length ? Math.max(...numericIds) : -1) + 1
  return lines.map((line, index) => ({ done: false, data: escapeHtml(line), id: firstId + index, indentLevel: 0 }))
}

function hasVisibleText(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, ' ').trim().length > 0
}

/** Structured (non-string) items cannot become plain lines without losing their content. */
export function canHideCheckboxes(items: ChecklistItem[]): boolean {
  return items.every(item => item.done || typeof item.data === 'string')
}

/** Unchecked items become lines; checked items are dropped and indentation is flattened. */
export function checkBoxesToBodyHtml(items: ChecklistItem[]): string {
  return items
    .filter(item => !item.done && typeof item.data === 'string' && hasVisibleText(item.data))
    .map(item => `<div>${item.data}</div>`)
    .join('')
}
