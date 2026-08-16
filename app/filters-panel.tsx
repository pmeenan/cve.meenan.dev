'use client'

/**
 * The filter drawer (UI revamp) — every knob that changes *what is counted*.
 *
 * One form drives both result shapes: **Run report** aggregates by the chosen
 * axes and charts it on the canvas; **List records** runs the same predicates
 * as a record search. They were two tabs (Explore, Report) sharing this form
 * by import; now they share it by being the same panel, which is the stronger
 * version of the M4 no-drift argument — there is no second copy to disagree.
 *
 * Chat writes into this panel too: a model-built definition lands here as the
 * populated form, exactly as if the reader had filled it in, which is what
 * makes a chat answer editable rather than final.
 */

import { draftToFilters, EMPTY_DRAFT, filtersToDraft, SORT_LABELS, type Draft } from '@/lib/draft'
import {
  DIMENSION_LABELS,
  DIMENSIONS,
  TIME_DIMENSIONS,
  type Dimension,
  type SortKey,
} from '@/lib/filters'
import type { Coverage } from '@/lib/protocol'
import { CHART_ROWS, TABLE_ROWS, type Report } from '@/lib/report'

import { Field, FilterForm } from './filter-form'

/** The time grains, offered first — a report over time is the common case. */
const TIME = DIMENSIONS.filter((dimension) => TIME_DIMENSIONS.has(dimension))
const ATTRIBUTES = DIMENSIONS.filter((dimension) => !TIME_DIMENSIONS.has(dimension))

export function FiltersPanel({
  report,
  onChange,
  onRunReport,
  onListRecords,
  groupBy,
  setGroupBy,
  sort,
  setSort,
  disabled,
  coverage,
}: {
  report: Report
  onChange: (report: Report) => void
  onRunReport: (report: Report) => void
  /** The same predicates as a record search — rendered on the canvas. */
  onListRecords: () => void
  groupBy: '' | Dimension
  setGroupBy: (value: '' | Dimension) => void
  sort: SortKey
  setSort: (sort: SortKey) => void
  disabled: boolean
  /** The date extent of the copy answering, for the date controls (M9). */
  coverage: Coverage | null
}) {
  const draft = filtersToDraft(report.filters)
  const setDraft = (next: Draft) => onChange({ ...report, filters: draftToFilters(next) })
  const set = <K extends keyof Report>(key: K, value: Report[K]) =>
    onChange({ ...report, [key]: value })

  return (
    <section className="filters-panel" aria-labelledby="filters-heading">
      <h2 id="filters-heading">Filters &amp; axes</h2>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault()
          onRunReport(report)
        }}
      >
        <div className="row">
          <Field label="Rows" id="report-rows">
            <select
              id="report-rows"
              value={report.rows}
              onChange={(event) => {
                const rows = event.target.value as Dimension
                // Changing Rows can make the existing split invalid. The
                // option disappears from the select in that state, but the
                // controlled value would otherwise remain unchanged and the
                // Worker would refuse the next run as a diagonal cross-tab.
                onChange({
                  ...report,
                  rows,
                  series: report.series === rows ? null : report.series,
                })
              }}
            >
              <optgroup label="Over time">
                {TIME.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {DIMENSION_LABELS[dimension]}
                  </option>
                ))}
              </optgroup>
              <optgroup label="By attribute">
                {ATTRIBUTES.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {DIMENSION_LABELS[dimension]}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="Split by" id="report-series">
            <select
              id="report-series"
              value={report.series ?? ''}
              onChange={(event) =>
                set('series', event.target.value === '' ? null : (event.target.value as Dimension))
              }
            >
              <option value="">No split — one count per row</option>
              <optgroup label="Over time">
                {TIME.filter((dimension) => dimension !== report.rows).map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {DIMENSION_LABELS[dimension]}
                  </option>
                ))}
              </optgroup>
              <optgroup label="By attribute">
                {ATTRIBUTES.filter((dimension) => dimension !== report.rows).map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {DIMENSION_LABELS[dimension]}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="Buckets" id="report-limit">
            <select
              id="report-limit"
              value={String(report.limit ?? CHART_ROWS)}
              onChange={(event) => set('limit', Number(event.target.value))}
            >
              {[6, 12, 24, 48, TABLE_ROWS].map((value) => (
                <option key={value} value={value}>
                  {value === TABLE_ROWS ? `${TABLE_ROWS} (table)` : String(value)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <FilterForm draft={draft} onChange={setDraft} idPrefix="report" coverage={coverage} />

        <div className="row">
          <Field label="Group by" id="explore-group">
            <select
              id="explore-group"
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as '' | Dimension)}
            >
              <option value="">No grouping — list records</option>
              {DIMENSIONS.map((dimension) => (
                <option key={dimension} value={dimension}>
                  {DIMENSION_LABELS[dimension]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sort records by" id="explore-sort">
            <select
              id="explore-sort"
              value={sort}
              disabled={groupBy !== ''}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="actions">
          <button type="submit" disabled={disabled}>
            Run report
          </button>
          <button type="button" disabled={disabled} onClick={onListRecords} data-list-records="1">
            List records
          </button>
          <button
            type="button"
            className="quiet"
            disabled={disabled}
            onClick={() => {
              onChange({ ...report, filters: draftToFilters(EMPTY_DRAFT) })
              setGroupBy('')
              setSort('published')
            }}
          >
            Reset filters
          </button>
        </div>
      </form>
    </section>
  )
}
