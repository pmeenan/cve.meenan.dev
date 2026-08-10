/**
 * Copying results out of the app: a chart as a PNG, a grid as something a
 * spreadsheet or a doc will paste cleanly.
 *
 * Two constraints shape this file.
 *
 * **Record content is hostile input (rule 4), and a paste target is another
 * program's parser.** Every cell goes through `sheetCell` (lib/sanitize.ts) —
 * the same D-071 boundary the CSV exports use — so a description or vendor
 * name that leads with `=`, `+`, `-` or `@` pastes as text rather than
 * executing as a formula, in the TSV flavour and the HTML one alike (Excel
 * evaluates both). The HTML flavour is additionally entity-escaped, because
 * it is handed to an HTML parser.
 *
 * **A copied artifact is the user's own report, not a copy of the corpus
 * (D-082).** What leaves through this file is the product of an
 * investigation — a chart image, a grid of derived numbers — and carries no
 * attribution block; MITRE's notice lives in the application UI and on the
 * served artifacts, where D-008 requires it.
 */

import { sheetCell } from './sanitize'

export type Cell = string | number | null

export interface GridData {
  title?: string
  columns: string[]
  rows: Cell[][]
}

/**
 * Tab-separated values, the one flavour Excel, Sheets and a plain editor all
 * paste correctly.
 */
export function gridToTsv(grid: GridData): string {
  const lines = [grid.columns.map(sheetCell).join('\t')]
  for (const row of grid.rows) lines.push(row.map(sheetCell).join('\t'))
  return lines.join('\n')
}

/** Escape a string for an HTML text node or attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The same grid as an HTML table, for paste targets that read `text/html` —
 * Docs, Word, and Excel all keep the table structure. Cells are formula-guarded
 * *and* escaped: the first is for the spreadsheet that evaluates pasted HTML,
 * the second for the parser reading this string.
 */
export function gridToHtml(grid: GridData): string {
  const th = grid.columns.map((column) => `<th>${escapeHtml(sheetCell(column))}</th>`).join('')
  const body = grid.rows
    .map(
      (row) => `<tr>${row.map((cell) => `<td>${escapeHtml(sheetCell(cell))}</td>`).join('')}</tr>`
    )
    .join('')
  const caption = grid.title ? `<caption>${escapeHtml(sheetCell(grid.title))}</caption>` : ''
  return `<table>${caption}<thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * Put a grid on the clipboard in both flavours.
 *
 * Returns a short human sentence rather than throwing: clipboard access is a
 * permission and a refusal is an ordinary outcome the UI reports beside the
 * button, not a failure state.
 */
export async function copyGrid(grid: GridData): Promise<string> {
  const tsv = gridToTsv(grid)
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([tsv], { type: 'text/plain' }),
          'text/html': new Blob([gridToHtml(grid)], { type: 'text/html' }),
        }),
      ])
    } else {
      await navigator.clipboard.writeText(tsv)
    }
    return `Copied ${grid.rows.length.toLocaleString()} rows — paste into a spreadsheet or a doc.`
  } catch {
    return 'The browser refused clipboard access. Use the export buttons instead.'
  }
}

/** How much bigger than CSS pixels the PNG is drawn. 2× reads cleanly when re-shared. */
const PNG_SCALE = 2
/** Vertical space for the drawn title band, in SVG units. */
const TITLE_BAND = 44
/** Height of one drawn legend row, and the padding under the last one. */
const LEGEND_ROW = 20
const LEGEND_PAD = 10

/** One legend entry as the copy path needs it: the drawn label and its colour. */
export interface LegendEntry {
  label: string
  /** A concrete colour or a `var(--…)` reference, resolved at draw time. */
  color: string
}

/**
 * Resolve the styling a chart's SVG gets from the stylesheet into attributes
 * on a clone.
 *
 * The SVG draws with `var(--…)` colours and classed strokes, all of which
 * resolve only inside this document — a serialized copy would rasterize
 * black-on-transparent. Computed styles are read from the *live* nodes and
 * written onto the clone as presentation attributes, so the PNG is the chart
 * as the reader sees it, in their own colour scheme.
 */
function inlineStyles(source: SVGSVGElement, clone: SVGSVGElement): void {
  const from = source.querySelectorAll<SVGElement>('*')
  const to = clone.querySelectorAll<SVGElement>('*')
  const carried = [
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linejoin',
    'stroke-linecap',
    'opacity',
    'font-size',
    'font-family',
    'text-anchor',
  ] as const
  from.forEach((node, at) => {
    const target = to[at]
    if (!target) return
    const computed = getComputedStyle(node)
    for (const property of carried) {
      const value = computed.getPropertyValue(property)
      if (value) target.setAttribute(property, value)
    }
    target.removeAttribute('class')
  })
}

/** A series colour as canvas ink: `var(--name)` resolved in the live document. */
function resolveColor(color: string): string {
  const reference = /^var\((--[^)]+)\)$/.exec(color.trim())
  if (!reference) return color
  const value = getComputedStyle(document.documentElement).getPropertyValue(reference[1]!)
  return value.trim() || '#888888'
}

export interface ChartPngOptions {
  /** The chart's on-screen title, drawn into the image. */
  title: string
  /** One line under the title — filters, match count, the data's build date. */
  subtitle?: string
  /**
   * The legend as drawn on screen: renames applied, hidden series absent.
   * Required for a multi-series chart — the legend is HTML in the page, so
   * without this the image has colours with no mapping. Empty for a chart
   * whose one series needs no legend.
   */
  legend?: LegendEntry[]
}

/**
 * Rasterize a chart SVG to a PNG and put it on the clipboard, falling back to
 * a download when the clipboard is refused (Safari and Firefox configurations
 * both can). Returns the sentence the UI shows beside the button.
 */
export async function copyChartPng(svg: SVGSVGElement, options: ChartPngOptions): Promise<string> {
  const blob = await renderChartPng(svg, options)
  if (blob === null) return 'Could not draw the chart to an image in this browser.'
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      throw new Error('no image clipboard')
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return 'Chart copied as an image — paste it anywhere.'
  } catch {
    downloadBlob(blob, pngFilename(options.title))
    return 'The browser refused the clipboard, so the chart was downloaded instead.'
  }
}

/** The same rendering, straight to a file. */
export async function downloadChartPng(
  svg: SVGSVGElement,
  options: ChartPngOptions
): Promise<string> {
  const blob = await renderChartPng(svg, options)
  if (blob === null) return 'Could not draw the chart to an image in this browser.'
  downloadBlob(blob, pngFilename(options.title))
  return 'Chart downloaded as a PNG.'
}

function pngFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'cve-report'}.png`
}

/**
 * Lay the legend out into rows that fit the image width.
 *
 * Measured with the same font the drawing uses, so the wrap is the real one.
 * Returns each entry with its position, plus the band height the canvas must
 * reserve.
 */
function layoutLegend(
  context: CanvasRenderingContext2D,
  legend: LegendEntry[],
  width: number
): { placed: { entry: LegendEntry; x: number; y: number }[]; band: number } {
  const placed: { entry: LegendEntry; x: number; y: number }[] = []
  if (legend.length === 0) return { placed, band: 0 }
  const left = 14
  const swatch = 10
  const gap = 18
  let x = left
  let row = 0
  for (const entry of legend) {
    const item = swatch + 5 + context.measureText(entry.label).width
    if (x > left && x + item > width - 14) {
      row += 1
      x = left
    }
    placed.push({ entry, x, y: row * LEGEND_ROW })
    x += item + gap
  }
  return { placed, band: (row + 1) * LEGEND_ROW + LEGEND_PAD }
}

async function renderChartPng(svg: SVGSVGElement, options: ChartPngOptions): Promise<Blob | null> {
  const viewBox = svg.viewBox.baseVal
  const width = viewBox?.width || svg.clientWidth || 860
  const height = viewBox?.height || svg.clientHeight || 400

  const clone = svg.cloneNode(true) as SVGSVGElement
  inlineStyles(svg, clone)
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  const styles = getComputedStyle(svg)
  const page = getComputedStyle(document.body)
  const background = page.backgroundColor || '#ffffff'
  const ink = page.color || '#16181d'
  const fontFamily = styles.fontFamily || 'system-ui, sans-serif'

  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' })
  )
  try {
    const image = await loadImage(url)
    const canvas = document.createElement('canvas')
    // The legend is measured before the canvas is sized: setting width/height
    // resets a 2D context, so the layout pass uses a throwaway one.
    const measure = document.createElement('canvas').getContext('2d')
    if (!measure) return null
    measure.font = `12px ${fontFamily}`
    const { placed, band } = layoutLegend(measure, options.legend ?? [], width)

    canvas.width = width * PNG_SCALE
    canvas.height = (height + TITLE_BAND + band) * PNG_SCALE
    const context = canvas.getContext('2d')
    if (!context) return null
    context.scale(PNG_SCALE, PNG_SCALE)
    context.fillStyle = background
    context.fillRect(0, 0, width, height + TITLE_BAND + band)

    // The title band. Record-derived text drawn as text — a canvas has no
    // parser to exploit, but the width is still bounded by measuring.
    context.fillStyle = ink
    context.font = `600 18px ${fontFamily}`
    context.fillText(fitText(context, options.title, width - 28), 14, 24)
    if (options.subtitle) {
      context.font = `12px ${fontFamily}`
      context.globalAlpha = 0.75
      context.fillText(fitText(context, options.subtitle, width - 28), 14, TITLE_BAND - 4)
      context.globalAlpha = 1
    }

    context.drawImage(image, 0, TITLE_BAND, width, height)

    // The legend, as the page shows it: same labels, same colours, wrapped to
    // the image's own width.
    context.font = `12px ${fontFamily}`
    for (const { entry, x, y } of placed) {
      const top = height + TITLE_BAND + y + 4
      context.fillStyle = resolveColor(entry.color)
      context.fillRect(x, top, 10, 10)
      context.fillStyle = ink
      context.fillText(entry.label, x + 15, top + 9)
    }

    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text
  let kept = text
  while (kept.length > 1 && context.measureText(`${kept}…`).width > maxWidth) {
    kept = kept.slice(0, -1)
  }
  return `${kept}…`
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('svg image failed to load'))
    image.src = url
  })
}

/** An object URL and a synthetic click — the same pattern the export path uses. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
