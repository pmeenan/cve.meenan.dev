'use client'

import { useState } from 'react'

import {
  CVSS_VERSION_LABELS,
  DIMENSIONS,
  SEVERITY_LABELS,
  STATE_LABELS,
  type Dimension,
  type Filters,
  type SortKey,
  type StateFilter,
} from '@/lib/filters'
import type { QueryResult, SearchRequest, Unmatched } from '@/lib/protocol'

/**
 * The filter surface: every confirmed filter axis, in one form (M3).
 *
 * Deliberately plain. M4 owns the structured filtering UI, charts, saved
 * queries and permalinks; what this milestone owes is that each axis is
 * *queryable* and that a person can see it answering. So this is a form and two
 * tables, and the interesting code is all in `lib/filters.ts` — which is also
 * what M4 will build on, since a `Filters` object is exactly what a permalink
 * and a chat-emitted report definition will carry (D-044).
 *
 * Lookup axes take names rather than ids, comma-separated. Names are what a
 * person has and what a saved query can survive an artifact rebuild with; ids
 * are the server's and mean nothing outside the generation that issued them
 * (D-055, D-056).
 */

/** What the form holds, before it becomes a `Filters`. All strings: this is a form. */
interface Draft {
  text: string
  cveId: string
  vendor: string
  product: string
  cna: string
  cwe: string
  host: string
  severity: number[]
  cvssVersion: number[]
  scoreMin: string
  scoreMax: string
  publishedFrom: string
  publishedTo: string
  updatedFrom: string
  updatedTo: string
  yearFrom: string
  yearTo: string
  state: StateFilter
  groupBy: '' | Dimension
  sort: SortKey
}

const EMPTY: Draft = {
  text: '',
  cveId: '',
  vendor: '',
  product: '',
  cna: '',
  cwe: '',
  host: '',
  severity: [],
  cvssVersion: [],
  scoreMin: '',
  scoreMax: '',
  publishedFrom: '',
  publishedTo: '',
  updatedFrom: '',
  updatedTo: '',
  yearFrom: '',
  yearTo: '',
  state: 'published',
  groupBy: '',
  sort: 'published',
}

const DIMENSION_LABELS: Record<Dimension, string> = {
  year: 'Year',
  severity: 'Severity',
  cvssVersion: 'CVSS version',
  state: 'State',
  cna: 'CNA',
  vendor: 'Vendor',
  product: 'Product',
  cwe: 'CWE',
  host: 'Reference host',
}

/** How many records a list asks for. Bounded again in the Worker (D-052 §4). */
const PAGE_ROWS = 100

export interface SearchOutcome {
  result: QueryResult
  matches: number | null
  unmatched: Unmatched[]
  groupBy: Dimension | null
  state: StateFilter
}

export function Explore({
  disabled,
  onRun,
  outcome,
  cancelledMs,
  run,
}: {
  disabled: boolean
  onRun: (request: SearchRequest) => void
  outcome: SearchOutcome | null
  cancelledMs: number | null
  /** Answer counter — rendered as `data-run` so a test can wait for *this* one. */
  run: number
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <section>
      <h2>Explore</h2>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault()
          onRun(toRequest(draft))
        }}
      >
        <div className="row">
          <Field label="Search descriptions">
            <input
              type="search"
              value={draft.text}
              placeholder="buffer overflow"
              onChange={(event) => set('text', event.target.value)}
            />
          </Field>
          <Field label="CVE ID">
            <input
              value={draft.cveId}
              placeholder="CVE-2021-44228"
              onChange={(event) => set('cveId', event.target.value)}
            />
          </Field>
        </div>

        <div className="row">
          <Names label="Vendor" draft={draft} field="vendor" set={set} placeholder="cisco" />
          <Names label="Product" draft={draft} field="product" set={set} placeholder="ios xe" />
          <Names label="CNA" draft={draft} field="cna" set={set} placeholder="mitre" />
          <Names label="CWE" draft={draft} field="cwe" set={set} placeholder="CWE-79, 787" />
          <Names
            label="Reference host"
            draft={draft}
            field="host"
            set={set}
            placeholder="github.com"
          />
        </div>

        <div className="row">
          <fieldset>
            <legend>Severity</legend>
            {Object.entries(SEVERITY_LABELS).map(([code, label]) => (
              <Check
                key={code}
                label={label}
                checked={draft.severity.includes(Number(code))}
                onChange={(on) => set('severity', toggle(draft.severity, Number(code), on))}
              />
            ))}
          </fieldset>
          <fieldset>
            <legend>CVSS version</legend>
            {Object.entries(CVSS_VERSION_LABELS).map(([code, label]) => (
              <Check
                key={code}
                label={label}
                checked={draft.cvssVersion.includes(Number(code))}
                onChange={(on) => set('cvssVersion', toggle(draft.cvssVersion, Number(code), on))}
              />
            ))}
          </fieldset>
          <fieldset>
            {/* D-022: the default is PUBLISHED only, and including REJECTED
                changes the denominator of everything above — so it is a
                deliberate choice with a warning, not a checkbox that quietly
                shifts the numbers. */}
            <legend>Records</legend>
            {(['published', 'rejected', 'all'] as StateFilter[]).map((value) => (
              <label key={value} className="check">
                <input
                  type="radio"
                  name="state"
                  checked={draft.state === value}
                  onChange={() => set('state', value)}
                />
                {value === 'published'
                  ? 'PUBLISHED only'
                  : value === 'rejected'
                    ? 'REJECTED only'
                    : 'All records'}
              </label>
            ))}
          </fieldset>
        </div>

        <div className="row">
          <Field label="CVSS score from">
            <input
              type="number"
              min="0"
              max="10"
              step="0.1"
              value={draft.scoreMin}
              onChange={(event) => set('scoreMin', event.target.value)}
            />
          </Field>
          <Field label="to">
            <input
              type="number"
              min="0"
              max="10"
              step="0.1"
              value={draft.scoreMax}
              onChange={(event) => set('scoreMax', event.target.value)}
            />
          </Field>
          <Field label="Published from">
            <input
              type="date"
              value={draft.publishedFrom}
              onChange={(event) => set('publishedFrom', event.target.value)}
            />
          </Field>
          <Field label="to">
            <input
              type="date"
              value={draft.publishedTo}
              onChange={(event) => set('publishedTo', event.target.value)}
            />
          </Field>
          <Field label="Updated from">
            <input
              type="date"
              value={draft.updatedFrom}
              onChange={(event) => set('updatedFrom', event.target.value)}
            />
          </Field>
          <Field label="to">
            <input
              type="date"
              value={draft.updatedTo}
              onChange={(event) => set('updatedTo', event.target.value)}
            />
          </Field>
          <Field label="Year from">
            <input
              type="number"
              value={draft.yearFrom}
              onChange={(event) => set('yearFrom', event.target.value)}
            />
          </Field>
          <Field label="to">
            <input
              type="number"
              value={draft.yearTo}
              onChange={(event) => set('yearTo', event.target.value)}
            />
          </Field>
        </div>

        <div className="row">
          <Field label="Group by">
            <select
              value={draft.groupBy}
              onChange={(event) => set('groupBy', event.target.value as '' | Dimension)}
            >
              <option value="">No grouping — list records</option>
              {DIMENSIONS.map((dimension) => (
                <option key={dimension} value={dimension}>
                  {DIMENSION_LABELS[dimension]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sort records by">
            <select
              value={draft.sort}
              disabled={draft.groupBy !== ''}
              onChange={(event) => set('sort', event.target.value as SortKey)}
            >
              <option value="published">Published, newest first</option>
              <option value="updated">Updated, newest first</option>
              <option value="score">CVSS score, highest first</option>
              <option value="cve">CVE ID, descending</option>
            </select>
          </Field>
          <div className="actions">
            <button type="submit" disabled={disabled}>
              Run
            </button>
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              onClick={() => setDraft(EMPTY)}
            >
              Reset filters
            </button>
          </div>
        </div>
      </form>

      {cancelledMs !== null && (
        <p className="muted" data-search-cancelled="1">
          Query cancelled after {(cancelledMs / 1000).toFixed(1)} s. Nothing was changed.
        </p>
      )}

      {outcome && <Results outcome={outcome} run={run} />}
    </section>
  )
}

function Results({ outcome, run }: { outcome: SearchOutcome; run: number }) {
  const { result, matches, unmatched, groupBy, state } = outcome
  return (
    <div className="outcome">
      {/* A name that matched nothing is a typo, not an empty corpus. Saying so
          is the same obligation as D-023's "this record has no indexed text"
          rather than "no results". */}
      {unmatched.map((entry) => (
        <p key={entry.axis} className="error" data-unmatched={entry.axis}>
          No {entry.axis} in this copy is called {entry.values.map((v) => `“${v}”`).join(', ')}.
          Those values cannot contribute matches. Group by {entry.axis} with no filter to see the
          names that exist.
        </p>
      ))}
      {state !== 'published' && (
        <p className="stale" data-state-warning={state}>
          {state === 'all'
            ? 'Including REJECTED records: about 4.8% of the corpus, which inflates every count below against the default (D-022).'
            : 'REJECTED records only — these are withdrawn CVE IDs, not vulnerabilities.'}
        </p>
      )}
      <p className="muted" data-matches={matches ?? ''} data-run={run}>
        {matches === null
          ? `${result.rows.length.toLocaleString()} rows`
          : `${matches.toLocaleString()} records match`}
        {groupBy ? ` — grouped by ${DIMENSION_LABELS[groupBy]},` : ' —'}{' '}
        {result.rows.length.toLocaleString()} shown in {result.ms} ms
        {result.truncated && ' (capped)'}
      </p>
      <div className="scroll">
        {groupBy ? (
          <GroupTable result={result} dimension={groupBy} />
        ) : (
          <RecordTable result={result} />
        )}
      </div>
      {/* The query behind the numbers, always available. Deterministic today;
          the same property the chat layer's answers will have to carry (D-044). */}
      <details className="sql">
        <summary>The SQL that produced this</summary>
        <pre>{result.sql}</pre>
        <p className="muted">Bound values: {result.params.map((p) => String(p)).join(' · ')}</p>
      </details>
    </div>
  )
}

function GroupTable({ result, dimension }: { result: QueryResult; dimension: Dimension }) {
  const total = result.rows.reduce((sum, row) => sum + Number(row[2] ?? 0), 0)
  return (
    <table className="results groups">
      <thead>
        <tr>
          <th>Value</th>
          <th>CVEs</th>
          <th>Share</th>
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, index) => {
          const count = Number(row[2] ?? 0)
          return (
            <tr key={index}>
              <td>{bucketLabel(row, dimension)}</td>
              <td>{count.toLocaleString()}</td>
              <td>
                {/* Share of what is on screen, not of the corpus — the table is
                    capped, so calling it a corpus share would be wrong. */}
                <span
                  className="bar-cell"
                  style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
                />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * The label for a grouped row.
 *
 * The severity, CVSS-version and state dimensions group by a stored *code*
 * (D-047: 31 is v3.1 and 4 is v4.0, so they are labels rather than magnitudes),
 * and the SQL returns the code in both columns. Mapping happens here rather
 * than in SQL because a `CASE` in the query would put display strings in the
 * query layer and still not cover a code we have never seen.
 */
function bucketLabel(row: unknown[], dimension: Dimension): string {
  const bucket = row[0]
  const label = row[1]
  if (label !== bucket && typeof label === 'string' && label.length > 0) return label
  if (bucket === null) return '(none recorded)'
  const code = Number(bucket)
  if (dimension === 'severity') return SEVERITY_LABELS[code] ?? String(bucket)
  if (dimension === 'cvssVersion') return CVSS_VERSION_LABELS[code] ?? String(bucket)
  if (dimension === 'state') return STATE_LABELS[code] ?? String(bucket)
  return String(bucket)
}

function RecordTable({ result }: { result: QueryResult }) {
  return (
    <table className="results records">
      <thead>
        <tr>
          <th>CVE</th>
          <th>Published</th>
          <th>Severity</th>
          <th>Score</th>
          <th>CNA</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, index) => (
          <tr key={index}>
            {/* Every cell is record content: attacker-influenced text rendered
                as text, never as markup, and no URL from a record is turned
                into a link here (rule 4). React escapes it; the point is that
                nothing downstream un-escapes it. */}
            <td className="mono">{String(row[0] ?? '')}</td>
            <td className="mono">{day(row[2])}</td>
            <td>{severity(row[6])}</td>
            <td className="mono">{row[5] === null ? '' : String(row[5])}</td>
            <td>{String(row[7] ?? '')}</td>
            <td className="descr">{String(row[8] ?? '')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function severity(value: unknown): string {
  return typeof value === 'number' ? (SEVERITY_LABELS[value] ?? String(value)) : ''
}

/** Unix seconds as an ISO day; the corpus stores whole timestamps we do not need. */
function day(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return new Date(value * 1000).toISOString().slice(0, 10)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function Names({
  label,
  draft,
  field,
  set,
  placeholder,
}: {
  label: string
  draft: Draft
  field: 'vendor' | 'product' | 'cna' | 'cwe' | 'host'
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  placeholder: string
}) {
  return (
    <Field label={label}>
      <input
        value={draft[field]}
        placeholder={placeholder}
        onChange={(event) => set(field, event.target.value)}
      />
    </Field>
  )
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

function toggle(values: number[], value: number, on: boolean): number[] {
  return on ? [...values, value] : values.filter((entry) => entry !== value)
}

/** The form as the Worker's request. Empty fields are omitted, not sent empty. */
function toRequest(draft: Draft): SearchRequest {
  const filters: Filters = { state: draft.state }
  if (draft.text.trim()) filters.text = draft.text.trim()
  if (draft.cveId.trim()) filters.cveId = draft.cveId.trim()
  for (const axis of ['vendor', 'product', 'cna', 'cwe', 'host'] as const) {
    const names = splitNames(draft[axis])
    if (names.length) filters[axis] = names
  }
  if (draft.severity.length) filters.severity = draft.severity
  if (draft.cvssVersion.length) filters.cvssVersion = draft.cvssVersion
  assignNumber(filters, 'scoreMin', draft.scoreMin)
  assignNumber(filters, 'scoreMax', draft.scoreMax)
  assignNumber(filters, 'yearFrom', draft.yearFrom)
  assignNumber(filters, 'yearTo', draft.yearTo)
  assignDay(filters, 'publishedFrom', draft.publishedFrom, 'start')
  assignDay(filters, 'publishedTo', draft.publishedTo, 'end')
  assignDay(filters, 'updatedFrom', draft.updatedFrom, 'start')
  assignDay(filters, 'updatedTo', draft.updatedTo, 'end')

  return {
    filters,
    groupBy: draft.groupBy === '' ? null : draft.groupBy,
    sort: draft.sort,
    limit: PAGE_ROWS,
    // The count is a second query — over the whole corpus with no filters it is
    // a scan — so it is asked for deliberately. It is worth it: "100 shown" of
    // an unknown total is not an answer.
    count: true,
  }
}

function splitNames(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function assignNumber(
  filters: Filters,
  key: 'scoreMin' | 'scoreMax' | 'yearFrom' | 'yearTo',
  raw: string
): void {
  if (!raw.trim()) return
  const value = Number(raw)
  if (Number.isFinite(value)) filters[key] = value
}

/**
 * A `<input type="date">` value as unix seconds.
 *
 * Parsed as UTC and the `to` end taken to the last second of the day, because
 * the corpus stores UTC timestamps: reading the box as local time would move
 * every boundary by the reader's offset and quietly drop a day's records at
 * each end.
 */
function assignDay(
  filters: Filters,
  key: 'publishedFrom' | 'publishedTo' | 'updatedFrom' | 'updatedTo',
  raw: string,
  edge: 'start' | 'end'
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return
  const at = Date.parse(`${raw}T00:00:00Z`)
  if (Number.isNaN(at)) return
  filters[key] = Math.floor(at / 1000) + (edge === 'end' ? 86_399 : 0)
}
