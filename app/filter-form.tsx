'use client'

/**
 * The filter form, shared by Explore and Report (M4).
 *
 * One component rather than two, because Explore and Report must not drift into
 * disagreeing about what an axis means — a "vendor" that includes rejected
 * records on one tab and not the other would make the two tabs answer different
 * questions with the same words. M3's form is the ancestor of this one; what
 * changed is that the state and its conversions moved out to `lib/draft.ts`, so
 * a permalink can populate the form as well as read it.
 *
 * Every control is labelled, and every group of checkboxes is a `fieldset` with
 * a `legend` — which is what makes the axis name reach a screen reader at all,
 * and what the axe-core pass asserts (M4's accessibility criterion).
 */

import { useId } from 'react'

import { clearChip, codeLabel, CODE_AXES, describeDraft, type Chip, type Draft } from '@/lib/draft'
import { DIMENSION_LABELS, NOT_ASSESSED, type StateFilter } from '@/lib/filters'

export function FilterChips({
  draft,
  onChange,
  disabled,
}: {
  draft: Draft
  onChange: (draft: Draft) => void
  disabled?: boolean
}) {
  const chips = describeDraft(draft)
  return (
    <ul className="chips" data-chips={chips.length}>
      {chips.map((chip) => (
        <li
          key={chip.key}
          className={chip.standing ? 'chip standing' : 'chip'}
          data-chip={chip.key}
        >
          <span>{chip.label}</span>
          {!chip.standing && chip.clears.length > 0 && (
            <button
              type="button"
              className="chip-clear"
              disabled={disabled}
              // The accessible name has to carry *which* filter this clears:
              // five buttons all called "Remove" is a keyboard user hearing the
              // same word five times with no way to choose.
              aria-label={`Remove filter: ${chip.label}`}
              onClick={() => onChange(clearChip(draft, chip as Chip))}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export function FilterForm({
  draft,
  onChange,
  idPrefix,
}: {
  draft: Draft
  onChange: (draft: Draft) => void
  /** Unique per instance: two forms on one route would otherwise share label targets. */
  idPrefix?: string
}) {
  const auto = useId()
  const prefix = idPrefix ?? auto
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value })

  return (
    <>
      <div className="row">
        <Field label="Search descriptions" id={`${prefix}-text`}>
          <input
            id={`${prefix}-text`}
            type="search"
            value={draft.text}
            placeholder="buffer overflow"
            onChange={(event) => set('text', event.target.value)}
          />
        </Field>
        <Field label="CVE ID" id={`${prefix}-cve`}>
          <input
            id={`${prefix}-cve`}
            value={draft.cveId}
            placeholder="CVE-2021-44228"
            onChange={(event) => set('cveId', event.target.value)}
          />
        </Field>
      </div>

      <div className="row">
        <Names
          label="Vendor"
          field="vendor"
          draft={draft}
          set={set}
          placeholder="cisco"
          prefix={prefix}
        />
        <Names
          label="Product"
          field="product"
          draft={draft}
          set={set}
          placeholder="ios xe"
          prefix={prefix}
        />
        <Names
          label="CNA"
          field="cna"
          draft={draft}
          set={set}
          placeholder="mitre"
          prefix={prefix}
        />
        <Names
          label="CWE"
          field="cwe"
          draft={draft}
          set={set}
          placeholder="CWE-79, 787"
          prefix={prefix}
        />
        <Names
          label="Reference host"
          field="host"
          draft={draft}
          set={set}
          placeholder="github.com"
          prefix={prefix}
        />
      </div>

      <div className="row">
        {/* Iterated from `CODE_AXES`, whose order is the *canonical* one, never
            a label map's keys: JavaScript orders integer-like keys numerically,
            so iterating the map renders v2.0, v4.0, v3.0, v3.1 — D-047's "codes
            are not magnitudes" confusion showing up in a checkbox list. */}
        {CODE_AXES.map((axis) => (
          <Codes key={axis.field} axis={axis} draft={draft} set={set} />
        ))}
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
                name={`${prefix}-state`}
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
        <Field label="CVSS score from" id={`${prefix}-score-min`}>
          <input
            id={`${prefix}-score-min`}
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={draft.scoreMin}
            onChange={(event) => set('scoreMin', event.target.value)}
          />
        </Field>
        <Field label="to" id={`${prefix}-score-max`}>
          <input
            id={`${prefix}-score-max`}
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={draft.scoreMax}
            onChange={(event) => set('scoreMax', event.target.value)}
          />
        </Field>
        <Field label="Published from" id={`${prefix}-pub-from`}>
          <input
            id={`${prefix}-pub-from`}
            type="date"
            value={draft.publishedFrom}
            onChange={(event) => set('publishedFrom', event.target.value)}
          />
        </Field>
        <Field label="to" id={`${prefix}-pub-to`}>
          <input
            id={`${prefix}-pub-to`}
            type="date"
            value={draft.publishedTo}
            onChange={(event) => set('publishedTo', event.target.value)}
          />
        </Field>
        <Field label="Updated from" id={`${prefix}-upd-from`}>
          <input
            id={`${prefix}-upd-from`}
            type="date"
            value={draft.updatedFrom}
            onChange={(event) => set('updatedFrom', event.target.value)}
          />
        </Field>
        <Field label="to" id={`${prefix}-upd-to`}>
          <input
            id={`${prefix}-upd-to`}
            type="date"
            value={draft.updatedTo}
            onChange={(event) => set('updatedTo', event.target.value)}
          />
        </Field>
        <Field label="Year from" id={`${prefix}-year-from`}>
          <input
            id={`${prefix}-year-from`}
            type="number"
            value={draft.yearFrom}
            onChange={(event) => set('yearFrom', event.target.value)}
          />
        </Field>
        <Field label="to" id={`${prefix}-year-to`}>
          <input
            id={`${prefix}-year-to`}
            type="number"
            value={draft.yearTo}
            onChange={(event) => set('yearTo', event.target.value)}
          />
        </Field>
      </div>

      {/* The catalog's own dates (M6). Separate from the corpus's because they
          are CISA's timeline rather than the CVE Program's: when a record was
          added to the known-exploited list, and when federal agencies had to
          have acted on it. Either one implies membership. */}
      <div className="row">
        <Field label="Added to KEV from" id={`${prefix}-kev-added-from`}>
          <input
            id={`${prefix}-kev-added-from`}
            type="date"
            value={draft.kevAddedFrom}
            onChange={(event) => set('kevAddedFrom', event.target.value)}
          />
        </Field>
        <Field label="to" id={`${prefix}-kev-added-to`}>
          <input
            id={`${prefix}-kev-added-to`}
            type="date"
            value={draft.kevAddedTo}
            onChange={(event) => set('kevAddedTo', event.target.value)}
          />
        </Field>
        <Field label="KEV due date from" id={`${prefix}-kev-due-from`}>
          <input
            id={`${prefix}-kev-due-from`}
            type="date"
            value={draft.kevDueFrom}
            onChange={(event) => set('kevDueFrom', event.target.value)}
          />
        </Field>
        <Field label="to" id={`${prefix}-kev-due-to`}>
          <input
            id={`${prefix}-kev-due-to`}
            type="date"
            value={draft.kevDueTo}
            onChange={(event) => set('kevDueTo', event.target.value)}
          />
        </Field>
      </div>
    </>
  )
}

export function Field({
  label,
  id,
  children,
}: {
  label: string
  id?: string
  children: React.ReactNode
}) {
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function Names({
  label,
  field,
  draft,
  set,
  placeholder,
  prefix,
}: {
  label: string
  field: 'vendor' | 'product' | 'cna' | 'cwe' | 'host'
  draft: Draft
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  placeholder: string
  prefix: string
}) {
  const id = `${prefix}-${field}`
  return (
    <Field label={label} id={id}>
      <input
        id={id}
        value={draft[field]}
        placeholder={placeholder}
        onChange={(event) => set(field, event.target.value)}
      />
    </Field>
  )
}

/**
 * One code axis as a checkbox group.
 *
 * The "not assessed" box is not decoration: `IN (…)` is never true for NULL, so
 * without it the band that holds half the corpus would be the one band a reader
 * can see on a chart and cannot select (D-070).
 */
function Codes({
  axis,
  draft,
  set,
}: {
  axis: (typeof CODE_AXES)[number]
  draft: Draft
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
}) {
  const selected = draft[axis.field]
  const codes = axis.absence ? [...axis.codes, NOT_ASSESSED] : [...axis.codes]
  return (
    <fieldset>
      <legend>{DIMENSION_LABELS[axis.field]}</legend>
      {codes.map((code) => (
        <Check
          key={code}
          label={codeLabel(axis.field, code)}
          checked={selected.includes(code)}
          onChange={(on) => set(axis.field, toggle(selected, code, on))}
        />
      ))}
    </fieldset>
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
