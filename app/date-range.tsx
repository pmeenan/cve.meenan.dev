'use client'

/**
 * The date range control (M9) — one component for every date pair in the app.
 *
 * It replaces two `<input type="date">` boxes, which failed at three things
 * that matter over a corpus spanning nearly thirty years:
 *
 * 1. **Typing did not work.** A *controlled* native date input fires `change`
 *    per segment, so typing `2025` into the year committed the year `0002` on
 *    the first keystroke and React re-rendered the box underneath the caret.
 *    Here the box is text, the keystrokes are local state, and a value is
 *    committed only when the whole string parses (`parseDayInput`).
 * 2. **Nothing said what the data covers.** The calendar offered 1970 and
 *    2099 over a corpus that starts in 1999 — ranges whose only possible
 *    answer is an empty chart. Bounds now come from the copy that is
 *    answering (`coverage`, lib/protocol.ts) and the grid refuses days
 *    outside them.
 * 3. **Reaching a month cost too many clicks.** Month and year are selects,
 *    two months are on screen at once, and the ranges people actually ask for
 *    are one click in the rail beside the calendar.
 *
 * **Empty is shown, not hidden.** An unset edge displays the dataset's own
 * boundary in muted text — the range the report is *actually* covering — so
 * the control always reads as seeded rather than blank, and adjusting it means
 * editing a date rather than inventing one. That display is not a filter: it
 * commits nothing to the report definition, which is what keeps a permalink
 * for "all time" free of predicates that would pin it to today's corpus.
 *
 * Dates are UTC end to end (lib/dates.ts), matching `lib/draft.ts`.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import {
  addDays,
  addMonths,
  clampDay,
  compareDay,
  datePresets,
  dayMonth,
  dayYear,
  endOfMonth,
  format,
  formatDayLong,
  matchPreset,
  monthGrid,
  monthLabel,
  MONTH_NAMES,
  parseDayInput,
  startOfMonth,
  withinBounds,
  WEEKDAY_INITIALS,
  WEEKDAY_NAMES,
  type Day,
  type DayBounds,
} from '@/lib/dates'

/** Today, in UTC — the same clock every boundary in this app is measured on. */
function today(): Day {
  return new Date().toISOString().slice(0, 10)
}

export function DateRangeField({
  label,
  idPrefix,
  from,
  to,
  bounds,
  onChange,
  disabled,
  inline,
  name,
}: {
  /** The axis, as the form says it: "Published", "Added to KEV". */
  label: string
  /** Input ids are `${idPrefix}-from` and `${idPrefix}-to` — stable selectors. */
  idPrefix: string
  from: string
  to: string
  /** The copy's extent on this axis, or null while it is unknown. */
  bounds: DayBounds | null
  onChange: (from: string, to: string) => void
  disabled?: boolean
  /** Row layout for the canvas strip; the drawer stacks label over box. */
  inline?: boolean
  /** `data-date-range` hook, for tests and for styling one instance. */
  name: string
}) {
  const [open, setOpen] = useState(false)
  /** Which box is being typed in, and what it holds — see the file header. */
  const [editing, setEditing] = useState<'from' | 'to' | null>(null)
  const [typed, setTyped] = useState('')
  /** What the box showed when it took focus, so a blur that changed nothing commits nothing. */
  const atFocus = useRef('')
  const wrapper = useRef<HTMLDivElement | null>(null)
  const toggle = useRef<HTMLButtonElement | null>(null)

  const hintId = `${idPrefix}-soft-hint`
  const softFrom = bounds?.min ?? ''
  const softTo = bounds?.max ?? ''
  const shown = (edge: 'from' | 'to') =>
    editing === edge ? typed : edge === 'from' ? from || softFrom : to || softTo

  const commit = (edge: 'from' | 'to', value: string) => {
    if (edge === 'from') onChange(value, to)
    else onChange(from, value)
  }

  /**
   * A typed box, as a filter — or as nothing, which is a different answer.
   *
   * Empty clears the edge. A string that parses is clamped into the data's
   * extent, because a boundary the calendar cannot show is a boundary nobody
   * can then edit. Anything else is left alone: the buffer stays, and blur
   * puts the committed value back rather than guessing.
   */
  const applyTyped = (edge: 'from' | 'to', raw: string): boolean => {
    if (!raw.trim()) {
      commit(edge, '')
      return true
    }
    const parsed = parseDayInput(raw, edge)
    if (!parsed) return false
    commit(edge, clampDay(parsed, bounds))
    return true
  }

  const box = (edge: 'from' | 'to') => {
    const id = `${idPrefix}-${edge}`
    const value = shown(edge)
    const soft = (edge === 'from' ? from : to) === ''
    return (
      <label className={inline ? 'field inline' : 'field'} htmlFor={id}>
        <span>{edge === 'from' ? `${label} from` : 'to'}</span>
        <input
          id={id}
          // The visible word on the closing edge is "to", which four date pairs
          // in one drawer all share. The accessible name says which axis it
          // closes, and still contains the visible word (WCAG 2.5.3).
          aria-label={`${label} ${edge === 'from' ? 'from' : 'to'}`}
          className="date-box"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          size={10}
          placeholder="yyyy-mm-dd"
          value={value}
          disabled={disabled}
          data-soft={soft && value ? '1' : undefined}
          aria-describedby={soft && value ? hintId : undefined}
          onFocus={(event) => {
            atFocus.current = event.target.value
            setEditing(edge)
            setTyped(event.target.value)
          }}
          // Keystrokes are buffered and **nothing is committed while typing**,
          // even once the buffer is a whole valid day. Committing there was
          // measured to be worse than the defect it replaced: the canvas re-runs
          // its report on a committed range, a running query disables this box,
          // and a disabled input drops the keys that follow — so typing
          // `2026-01-01` and continuing lost the rest of the edit. Enter and
          // blur are the two commits, and both happen when the reader is done.
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => {
            const raw = typed
            setEditing(null)
            if (raw === atFocus.current) return
            applyTyped(edge, raw)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (applyTyped(edge, typed)) {
                setEditing(null)
                // The commit re-runs the report, which disables this box, and
                // Firefox fires `blur` on a focused input that becomes disabled
                // — so without this the blur handler above would see a changed
                // box and commit the same edit a second time (a second, identical
                // query, seen only on that engine).
                atFocus.current = typed
              }
            } else if (event.key === 'Escape' && editing === edge) {
              event.preventDefault()
              setEditing(null)
            }
          }}
        />
      </label>
    )
  }

  // Close on a click outside, and on Escape from anywhere inside. Both are
  // registered only while the popover is open: a dismissal listener that
  // outlives its dialog is how a picker ends up eating clicks elsewhere.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      toggle.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div
      className={inline ? 'date-range inline' : 'date-range'}
      data-date-range={name}
      ref={wrapper}
    >
      {box('from')}
      {box('to')}
      <button
        ref={toggle}
        type="button"
        className="quiet icon date-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label} dates — open the calendar`}
        title="Pick from a calendar"
        data-date-open={name}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        <CalendarIcon />
      </button>
      <span id={hintId} className="visually-hidden">
        Showing the {label.toLowerCase()} range the data covers. No filter is applied on this edge
        until you change it.
      </span>
      {open && (
        <Popover
          label={label}
          name={name}
          from={from}
          to={to}
          bounds={bounds}
          anchor={wrapper}
          onPick={(nextFrom, nextTo) => onChange(nextFrom, nextTo)}
          onClose={() => {
            setOpen(false)
            toggle.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/**
 * The calendar itself.
 *
 * `position: fixed`, placed from the anchor's rect, because the filter drawer
 * scrolls (`.side-panel { overflow-y: auto }`) and an absolutely positioned
 * popover inside it would be clipped by its own container — the failure that
 * makes a picker unusable in exactly the panel it lives in.
 */
function Popover({
  label,
  name,
  from,
  to,
  bounds,
  anchor,
  onPick,
  onClose,
}: {
  label: string
  name: string
  from: string
  to: string
  bounds: DayBounds | null
  anchor: React.RefObject<HTMLDivElement | null>
  onPick: (from: string, to: string) => void
  onClose: () => void
}) {
  const now = today()
  const titleId = useId()
  const panel = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)

  /**
   * Where the calendar opens: the range's own start if it has one, the data's
   * last day otherwise — never today, which for a corpus whose head is a week
   * old is the wrong month by default. Clamped, so a permalink carrying a
   * boundary this copy does not cover opens on data rather than on a grid of
   * disabled days.
   */
  const anchorDay = clampDay(from || to || bounds?.max || now, bounds)
  const [cursor, setCursor] = useState<Day>(() => startOfMonth(anchorDay))
  /** The first click of a two-click range, held until the second lands. */
  const [pending, setPending] = useState<Day | null>(null)
  const [hover, setHover] = useState<Day | null>(null)
  /** Roving tabindex: the one day button that is reachable with Tab. */
  const [focusDay, setFocusDay] = useState<Day>(() => anchorDay)
  const focusWanted = useRef(true)

  // What the grid shades. While a first click is pending the range follows the
  // pointer, in whichever direction it moved — picking backwards is picking a
  // range, not a mistake.
  const other = pending ? (hover ?? pending) : ''
  const backwards = !!pending && !!other && compareDay(other, pending) < 0
  const rangeFrom = pending ? (backwards ? other : pending) : from
  const rangeTo = pending ? (backwards ? pending : other) : to

  const presets = datePresets(bounds, clampDay(now, bounds))
  const active = matchPreset(presets, from, to)

  /**
   * Place the panel under its field, flipping above it when the space below
   * cannot hold it and clamping into the viewport either way. Measured rather
   * than assumed: the drawer's fields sit at every height in a scrolling panel.
   */
  useLayoutEffect(() => {
    const measure = () => {
      const rect = anchor.current?.getBoundingClientRect()
      const box = panel.current?.getBoundingClientRect()
      if (!rect || !box) return
      const margin = 8
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - box.width - margin))
      const below = rect.bottom + 6
      const top =
        below + box.height > window.innerHeight - margin && rect.top - box.height - 6 > margin
          ? rect.top - box.height - 6
          : Math.max(margin, Math.min(below, window.innerHeight - box.height - margin))
      // Same place, same object: an unconditional set would re-render on every
      // scroll event, and every render would schedule another measurement.
      setPlace((was) => (was && was.left === left && was.top === top ? was : { left, top }))
    }
    measure()
    // Reposition rather than drift: the anchor moves when the drawer or the
    // page scrolls, and a fixed panel that stayed put would detach from its
    // field. Capture, because the drawer is the element that scrolls, not the
    // window.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchor])

  const move = (day: Day) => {
    const next = clampDay(day, bounds)
    setFocusDay(next)
    focusWanted.current = true
    // Follow the cursor into a month that is not on screen, keeping the
    // two-month window anchored so paging feels continuous.
    if (compareDay(next, startOfMonth(cursor)) < 0) setCursor(startOfMonth(next))
    else if (compareDay(next, endOfMonth(addMonths(cursor, 1))) > 0) {
      setCursor(startOfMonth(addMonths(next, -1)))
    }
  }

  const pick = (day: Day) => {
    if (!withinBounds(day, bounds)) return
    if (!pending) {
      setPending(day)
      setHover(null)
      return
    }
    const [start, end] = compareDay(day, pending) < 0 ? [day, pending] : [pending, day]
    setPending(null)
    onPick(start, end)
    onClose()
  }

  const onGridKey = (event: React.KeyboardEvent) => {
    const jump: Record<string, () => Day> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      Home: () => addDays(focusDay, -new Date(`${focusDay}T00:00:00Z`).getUTCDay()),
      End: () => addDays(focusDay, 6 - new Date(`${focusDay}T00:00:00Z`).getUTCDay()),
      PageUp: () => addMonths(focusDay, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focusDay, event.shiftKey ? 12 : 1),
    }
    const next = jump[event.key]
    if (!next) return
    event.preventDefault()
    move(next())
  }

  const years = yearOptions(bounds, cursor, now)

  return (
    <div
      className="date-pop"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-date-pop={name}
      ref={panel}
      // Hidden by *opacity* for the one frame before it has been measured,
      // never by `visibility`: the calendar moves focus onto a day as it
      // opens, and `focus()` on anything inside a `visibility: hidden` subtree
      // is silently ignored — which cost this control its whole keyboard path.
      style={
        place
          ? { left: `${place.left}px`, top: `${place.top}px` }
          : { opacity: 0, pointerEvents: 'none' }
      }
    >
      <h3 id={titleId} className="date-pop-title">
        {label} range
        <span className="muted">
          {from || to
            ? ` — ${from || 'earliest'} to ${to || 'latest'}`
            : bounds
              ? ` — all time (${bounds.min} to ${bounds.max})`
              : ' — all time'}
        </span>
      </h3>

      <div className="date-pop-body">
        <div className="date-presets" role="group" aria-label={`${label} range shortcuts`}>
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className="quiet"
              aria-pressed={active === preset.key}
              data-preset={preset.key}
              onClick={() => {
                setPending(null)
                onPick(preset.from, preset.to)
                onClose()
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="date-cal">
          <div className="date-cal-head">
            <button
              type="button"
              className="quiet icon"
              aria-label="Previous month"
              data-month-step="-1"
              disabled={!!bounds && compareDay(endOfMonth(addMonths(cursor, -1)), bounds.min) < 0}
              onClick={() => setCursor(addMonths(cursor, -1))}
            >
              ‹
            </button>
            <label className="visually-hidden" htmlFor={`${titleId}-month`}>
              Month
            </label>
            <select
              id={`${titleId}-month`}
              value={dayMonth(cursor)}
              data-cal-month="1"
              onChange={(event) =>
                setCursor(format(dayYear(cursor), Number(event.target.value), 1))
              }
            >
              {MONTH_NAMES.map((month, index) => (
                <option
                  key={month}
                  value={index + 1}
                  disabled={outsideBounds(dayYear(cursor), index + 1, bounds)}
                >
                  {month}
                </option>
              ))}
            </select>
            <label className="visually-hidden" htmlFor={`${titleId}-year`}>
              Year
            </label>
            <select
              id={`${titleId}-year`}
              value={dayYear(cursor)}
              data-cal-year="1"
              // Clamped into the data: the first and last years a copy holds
              // are partial ones, so keeping the month while changing the year
              // can land on a month the corpus does not reach — a grid of
              // disabled days, reached by using the control as intended.
              onChange={(event) =>
                setCursor(
                  startOfMonth(
                    clampDay(format(Number(event.target.value), dayMonth(cursor), 1), bounds)
                  )
                )
              }
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="quiet icon"
              aria-label="Next month"
              data-month-step="1"
              disabled={!!bounds && compareDay(startOfMonth(addMonths(cursor, 1)), bounds.max) > 0}
              onClick={() => setCursor(addMonths(cursor, 1))}
            >
              ›
            </button>
          </div>

          {/* Two months, because a range that spans a boundary is the common
              one and picking it across a single month means paging mid-range. */}
          <div className="date-months" onKeyDown={onGridKey}>
            {[0, 1].map((offset) => (
              <Month
                key={offset}
                anchorDay={addMonths(cursor, offset)}
                bounds={bounds}
                today={now}
                rangeFrom={rangeFrom}
                rangeTo={rangeTo}
                focusDay={focusDay}
                focusWanted={focusWanted}
                onPick={pick}
                onHover={(day) => pending && setHover(day)}
                onFocusDay={setFocusDay}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="date-pop-foot">
        <p className="muted" data-date-extent="1">
          {bounds
            ? `Data covers ${bounds.min} to ${bounds.max}.`
            : 'The extent of this copy is not known yet.'}
          {pending ? ' Pick the end of the range.' : ''}
        </p>
        <div className="actions">
          <button
            type="button"
            className="quiet"
            data-date-clear="1"
            onClick={() => {
              setPending(null)
              onPick('', '')
            }}
          >
            Clear
          </button>
          <button type="button" onClick={onClose} data-date-done="1">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function Month({
  anchorDay,
  bounds,
  today: now,
  rangeFrom,
  rangeTo,
  focusDay,
  focusWanted,
  onPick,
  onHover,
  onFocusDay,
}: {
  anchorDay: Day
  bounds: DayBounds | null
  today: Day
  rangeFrom: string
  rangeTo: string
  focusDay: Day
  focusWanted: React.RefObject<boolean>
  onPick: (day: Day) => void
  onHover: (day: Day) => void
  onFocusDay: (day: Day) => void
}) {
  const year = dayYear(anchorDay)
  const month = dayMonth(anchorDay)
  const weeks = monthGrid(year, month)

  return (
    <table className="date-grid" data-month={`${year}-${String(month).padStart(2, '0')}`}>
      <caption>{monthLabel(year, month)}</caption>
      <thead>
        <tr>
          {WEEKDAY_INITIALS.map((initial, index) => (
            <th key={index} scope="col" abbr={WEEKDAY_NAMES[index]}>
              {initial}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0]!.day}>
            {week.map(({ day, inMonth }) => {
              // A day belongs to exactly one of the two tables on screen, so
              // the leading and trailing cells are rendered blank rather than
              // twice — two buttons for the same date would be two tab stops
              // and two things to keep in sync.
              if (!inMonth) return <td key={day} className="pad" />
              const disabled = !withinBounds(day, bounds)
              const isStart = !!rangeFrom && day === rangeFrom
              const isEnd = !!rangeTo && day === rangeTo
              const inRange =
                !!rangeFrom &&
                !!rangeTo &&
                compareDay(day, rangeFrom) >= 0 &&
                compareDay(day, rangeTo) <= 0
              return (
                <td key={day} className={inRange ? 'in-range' : undefined}>
                  <button
                    type="button"
                    className="date-day"
                    tabIndex={day === focusDay ? 0 : -1}
                    disabled={disabled}
                    data-day={day}
                    data-selected={isStart || isEnd ? '1' : undefined}
                    data-in-range={inRange && !isStart && !isEnd ? '1' : undefined}
                    data-today={day === now ? '1' : undefined}
                    aria-pressed={isStart || isEnd}
                    aria-label={formatDayLong(day)}
                    ref={(node) => {
                      // Focus follows the roving index, but only when a key
                      // moved it (or the dialog just opened): stealing focus on
                      // every render would fight the text boxes above.
                      if (node && day === focusDay && focusWanted.current) {
                        focusWanted.current = false
                        node.focus()
                      }
                    }}
                    onMouseEnter={() => onHover(day)}
                    onFocus={() => onFocusDay(day)}
                    onClick={() => onPick(day)}
                  >
                    {Number(day.slice(8, 10))}
                  </button>
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Whether a whole month lies outside the data, so the select can refuse it. */
function outsideBounds(year: number, month: number, bounds: DayBounds | null): boolean {
  if (!bounds) return false
  const first = format(year, month, 1)
  return compareDay(endOfMonth(first), bounds.min) < 0 || compareDay(first, bounds.max) > 0
}

/**
 * The years the select offers: the ones the data has, and never fewer than the
 * year on screen — a permalink can carry a range the current copy no longer
 * covers, and a select that cannot show its own value is a select that silently
 * changes it.
 */
function yearOptions(bounds: DayBounds | null, cursor: Day, now: Day): number[] {
  const current = dayYear(cursor)
  const low = bounds ? dayYear(bounds.min) : dayYear(now) - 30
  const high = bounds ? dayYear(bounds.max) : dayYear(now) + 1
  const years: number[] = []
  for (let year = Math.min(low, current); year <= Math.max(high, current); year += 1) {
    years.push(year)
  }
  return years
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="3" width="13" height="11.5" rx="1.5" fill="none" stroke="currentColor" />
      <path d="M1.5 6.5h13" stroke="currentColor" />
      <path d="M5 1.5v3M11 1.5v3" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}
