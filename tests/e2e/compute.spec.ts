import { expect, test } from '@playwright/test'

import { requireLocalStorage } from './support'
import { agentCall, awaitIdle, importCorpus } from './ui'

import { SANDBOX_CSP } from '../../lib/sandbox-doc'

/**
 * The compute tool and `window.cveExplorer.last()` (D-088), in a browser.
 *
 * `compute` runs model-written JavaScript over the full rows of the most
 * recent result. Everything about it that matters is a *boundary*, and a
 * boundary is proved by trying to cross it, not by reading the config: the
 * frame's origin is opaque, so there is no storage and no OPFS to reach; its
 * CSP is `default-src 'none'`, so a blob: worker made inside it cannot fetch;
 * a runaway loop is terminated at the deadline and the next call still
 * answers. Each of those is checked here from inside the sandbox — the same
 * discipline as RE-024's lesson: a guard that is only assumed to be there is
 * one that can be missing while every test passes.
 *
 * `last()` is the agent-side counterpart: the same rows the sandbox would
 * receive, handed to an extension's own code, whole.
 */

test.describe('the compute sandbox and the last result', () => {
  test('last() is the most recent result, whole, whoever ran it', async ({ page }) => {
    test.setTimeout(600_000)
    await page.goto('/?remote=0')
    await requireLocalStorage(page)
    await importCorpus(page, 300_000)
    await awaitIdle(page)

    // The opening report ran on the canvas: that is the last result, and its
    // match count is what the canvas reports.
    const opening = await last(page)
    expect(opening?.source).toBe('aggregate')
    expect(opening?.rows.length).toBeGreaterThan(0)
    expect(String(opening?.matches)).toBe(
      await page.getAttribute('[data-report-matches]', 'data-report-matches')
    )

    // A tool call replaces it — every row the query layer returned, not the
    // window the model is shown — and a copy: mutating it changes nothing.
    const listed = await agentCall(page, 'search_records', { severity: ['CRITICAL'], limit: 120 })
    expect(listed.rowsShown).toBe(50)
    const records = await last(page)
    expect(records?.source).toBe('records')
    expect(records?.rows.length).toBe(120)
    expect(records?.columns).toContain('cve')
    expect(records?.columns).toContain('description')
    await page.evaluate(() => {
      const w = window as unknown as { cveExplorer: { last(): { rows: unknown[][] } } }
      w.cveExplorer.last().rows.length = 0
    })
    expect((await last(page))?.rows.length).toBe(120)
  })

  test('compute runs over the last result and answers what a query cannot', async ({ page }) => {
    test.setTimeout(600_000)
    await page.goto('/?remote=0')
    await requireLocalStorage(page)
    await importCorpus(page, 300_000)
    await awaitIdle(page)

    await agentCall(page, 'search_records', { severity: ['CRITICAL'], limit: 200 })
    const computed = await agentCall(page, 'compute', {
      code:
        'const words = /overflow|injection|traversal/i;' +
        'const hits = data.filter((r) => words.test(String(r.description ?? "")));' +
        'console.log("rows", rows.length);' +
        'return { rows: rows.length, columns, hits: hits.length, first: data[0].cve, ' +
        'severities: [...new Set(data.map((r) => r.cvss_sev))] }',
    })
    expect(computed.tool).toBe('compute')
    expect(computed.ok, JSON.stringify(computed)).toBe(true)
    const value = JSON.parse(computed.value as string) as {
      rows: number
      columns: string[]
      hits: number
      first: string
      severities: unknown[]
    }
    expect(value.rows).toBe(200)
    expect(value.columns).toContain('cve')
    expect(value.first).toMatch(/^CVE-\d{4}-\d+$/)
    expect(value.severities).toEqual([4])
    expect(value.hits).toBeGreaterThanOrEqual(0)
    expect(computed.logs).toEqual(['rows 200'])
    expect((computed.input as { source: string; rows: number }).source).toBe('records')
    expect((computed.input as { source: string; rows: number }).rows).toBe(200)

    // A thrown error is an answer, not a broken turn — the model is told
    // what failed so it can fix the code.
    const threw = await agentCall(page, 'compute', { code: 'return data[0].nope.deeper' })
    expect(threw.ok).toBe(false)
    expect(String(threw.error)).toMatch(/TypeError/)
    // From the agent surface nothing lands on the canvas, and the last result
    // is still the search — compute never replaces the data it read.
    expect((await last(page))?.source).toBe('records')

    // Every agent call is on screen for the person at the page — the "Agent
    // activity" log renders each through the chat step component: the
    // computed value with its code, a KEV claim, a refusal, a record read
    // that found nothing (which also clears any record that was open).
    const log = page.locator('[data-agent-log]')
    await expect(log).toBeVisible()
    await expect(log.locator('[data-chat-step="compute"]')).toHaveCount(2)
    await expect(
      log.locator('[data-chat-step="compute"] [data-chat-compute="ok"]').first()
    ).toBeVisible()
    await expect(
      log.locator('[data-chat-step="compute"] [data-chat-compute-value]').first()
    ).toContainText('"rows":200')
    await agentCall(page, 'kev_lookup', { cveId: 'CVE-2021-44228' })
    await expect(log.locator('[data-chat-step="kev_lookup"] [data-chat-kev]')).toBeVisible()
    await agentCall(page, 'no_such_tool', {})
    await expect(
      log.locator('[data-chat-step="no_such_tool"][data-chat-status="refused"]')
    ).toBeVisible()
    await agentCall(page, 'cve_detail', { cveId: 'CVE-2099-99999' })
    await expect(log.locator('[data-chat-step="cve_detail"]')).toContainText(
      'No record in this copy'
    )
    await expect(page.locator('section.canvas')).toContainText('No record in this copy carries')
    // Newest first, so the refusal sits above the compute steps.
    const order = await log
      .locator('[data-chat-step]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-chat-step')))
    expect(order.slice(0, 3)).toEqual(['cve_detail', 'no_such_tool', 'kev_lookup'])
  })

  test('the sandbox has no network, no storage, no origin — and a runaway loop is stopped', async ({
    page,
    browserName,
  }) => {
    test.setTimeout(600_000)
    await page.goto('/?remote=0')
    await requireLocalStorage(page)
    await importCorpus(page, 300_000)
    await awaitIdle(page)

    // Every escape a program in the sandbox could try, tried, and reported
    // back as data. `fetch` and friends are removed from the worker global
    // (so this reads as ReferenceErrors), the origin is opaque (`null`), and
    // storage APIs are absent — the properties the boundary rests on.
    const probe = await agentCall(page, 'compute', {
      code: `
        const out = {}
        const attempt = (name, fn) => { try { const v = fn(); out[name] = v instanceof Promise ? 'promise' : 'value:' + String(v).slice(0, 40) } catch (e) { out[name] = 'error:' + (e && e.name) } }
        attempt('fetch', () => fetch('/api/sql.php'))
        attempt('xhr', () => new XMLHttpRequest())
        attempt('websocket', () => new WebSocket('wss://example.com/'))
        attempt('eventsource', () => new EventSource('/'))
        attempt('importScripts', () => importScripts('/sw.js'))
        attempt('worker', () => new Worker('/sw.js'))
        attempt('indexedDB', () => indexedDB.open('x'))
        attempt('caches', () => caches.open('x'))
        attempt('opfs', () => navigator.storage.getDirectory())
        attempt('sendBeacon', () => navigator.sendBeacon('/', 'x'))
        attempt('localStorage', () => localStorage.getItem('x'))
        attempt('cookie', () => document.cookie)
        attempt('parent', () => parent.document)
        out.origin = String(self.location.origin)
        out.protocol = String(self.location.protocol)
        return out
      `,
    })
    expect(probe.ok, JSON.stringify(probe)).toBe(true)
    const out = JSON.parse(probe.value as string) as Record<string, string>
    for (const name of [
      'fetch',
      'xhr',
      'websocket',
      'eventsource',
      'importScripts',
      'worker',
      'indexedDB',
      'caches',
      'opfs',
      'sendBeacon',
      'localStorage',
      'cookie',
      'parent',
    ]) {
      expect(out[name], `${name}: ${out[name]}`).toMatch(/^error:/)
    }
    // A blob: worker in an opaque-origin document: its origin is the
    // serialisation of null, and it is not this site's.
    expect(out.origin).toBe('null')
    expect(out.protocol).toBe('blob:')

    // The CSP itself, not just the removed globals: a worker made in a frame
    // built the same way — sandboxed `srcdoc`, the same meta policy — with
    // `fetch` intact is refused by the engine, and so is the frame's own
    // window. Checked from a frame the test builds because from inside
    // `compute` there is no `fetch` left to call, which is the point of
    // removing it; the property that has to hold on this engine is that the
    // meta policy binds a blob: worker in a sandboxed srcdoc document.
    const csp = await page.evaluate(
      (policy) =>
        new Promise<{ window: string; worker: string }>((resolve) => {
          const probe =
            '<!doctype html><meta charset="utf-8">' +
            `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
            '<script>' +
            'const report = { window: "", worker: "" };' +
            'const settle = () => { if (report.window && report.worker) parent.postMessage({ type: "csp-probe", ...report }, "*") };' +
            'fetch("/llms.txt").then(() => { report.window = "fetched"; settle() }, (e) => { report.window = "blocked:" + e.name; settle() });' +
            'const source = \'fetch("/llms.txt").then(() => postMessage("fetched"), (e) => postMessage("blocked:" + e.name))\';' +
            'const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));' +
            'worker.onmessage = (e) => { report.worker = String(e.data); settle() };' +
            'worker.onerror = (e) => { report.worker = "error:" + e.message; settle() };' +
            '</script>'
          const frame = document.createElement('iframe')
          frame.setAttribute('sandbox', 'allow-scripts')
          frame.srcdoc = probe
          const onMessage = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow) return
            const data = event.data as { type?: string; window?: string; worker?: string }
            if (data?.type !== 'csp-probe') return
            window.removeEventListener('message', onMessage)
            frame.remove()
            resolve({ window: String(data.window), worker: String(data.worker) })
          }
          window.addEventListener('message', onMessage)
          document.body.appendChild(frame)
          setTimeout(() => resolve({ window: 'timeout', worker: 'timeout' }), 8_000)
        }),
      SANDBOX_CSP
    )
    expect(csp.window, `window fetch on ${browserName}: ${csp.window}`).toMatch(/^blocked:/)
    expect(csp.worker, `worker fetch on ${browserName}: ${csp.worker}`).toMatch(/^blocked:/)

    // A loop that never returns is stopped at the deadline, reported as
    // such, and the next call still answers — a fresh worker per call, and a
    // frame that is torn down if it stops answering.
    const started = Date.now()
    const runaway = await agentCall(page, 'compute', { code: 'while (true) {}' })
    const elapsed = Date.now() - started
    expect(runaway.ok).toBe(false)
    expect(String(runaway.error)).toMatch(/stopped/)
    expect(elapsed).toBeGreaterThanOrEqual(9_000)
    expect(elapsed).toBeLessThan(20_000)
    const after = await agentCall(page, 'compute', { code: 'return 6 * 7' })
    expect(after.ok).toBe(true)
    expect(after.value).toBe('42')
  })
})

async function last(page: import('@playwright/test').Page): Promise<{
  source: string
  rows: unknown[][]
  columns: string[]
  matches: number | null
} | null> {
  return page.evaluate(() =>
    (
      window as unknown as {
        cveExplorer: {
          last(): {
            source: string
            rows: unknown[][]
            columns: string[]
            matches: number | null
          } | null
        }
      }
    ).cveExplorer.last()
  )
}
