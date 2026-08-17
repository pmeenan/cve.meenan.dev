'use client'

/**
 * A hybrid combobox for the canvas's Vendor and Product selectors (UI polish,
 * 2026-08-16): a text box that filters a list as you type — case-insensitive,
 * substring, ranked by `lib/catalog.ts` — and takes either a listed name or
 * whatever was typed. "All" is the empty value.
 *
 * Nothing here queries anything. The parent hands in a `search` over the
 * in-memory catalog and is told the chosen name; the choice reaches SQL as a
 * bound name in `filters.vendor` / `filters.product`, exactly as a permalink's
 * would. Every label is record text (rule 4) and is rendered as a text node.
 *
 * Commits happen on a pick, on Enter, or on blur with a changed box — never
 * mid-keystroke, for the reason `date-range.tsx` gives: a commit re-runs the
 * report, a running query disables the box, and a disabled input eats the
 * keys after it (RE-037).
 */

import { useEffect, useId, useRef, useState } from 'react'

export interface PickerItem {
  /** Unique within one list. */
  key: string
  /** The name a pick commits — record text, rendered as text. */
  label: string
  /** Secondary text beside the name (the vendors a product name lives under). */
  detail?: string
  /** A rank shown muted at the right, e.g. how many CVEs list it. */
  hint?: string
}

/** How many matches the list shows; the box narrows the rest. */
export const PICKER_ROWS = 40

export function Picker({
  label,
  name,
  value,
  allLabel,
  search,
  onPick,
  disabled,
  loading,
}: {
  label: string
  /** The `data-picker` hook, for tests and for styling one instance. */
  name: string
  /** The committed value: the filter's names, joined for display. Empty is "All". */
  value: string
  /** What an empty value reads as, e.g. "All vendors". */
  allLabel: string
  search: (query: string) => PickerItem[]
  /** `null` is "All". */
  onPick: (name: string | null) => void
  disabled?: boolean
  /** The catalog has not arrived: typing still works, the list is empty. */
  loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  /**
   * The box's text while it is being edited. Only meaningful while `open`: at
   * rest the box shows the committed `value`, so a value that changes
   * underneath — chat set a vendor, a chip was dismissed, Reset — is shown at
   * once, and an edit in progress is never replaced under the reader's
   * fingers. Derived rather than synchronised, so there is no effect to race.
   */
  const [draft, setDraft] = useState('')
  const typed = open ? draft : value
  const [active, setActive] = useState(0)
  const wrapper = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const listId = useId()
  const inputId = useId()

  const items = open ? search(typed) : []
  const activeIndex = Math.min(active, Math.max(0, items.length - 1))
  const highlighted = items[activeIndex]

  const commit = (next: string | null) => {
    setOpen(false)
    // The trimmed name, or All for an emptied box: clearing the text is the
    // gesture for "any vendor", and it must not re-run with the old value.
    onPick(next === null || next.trim() === '' ? null : next.trim())
  }

  // Close on a click outside. Registered only while open — a listener that
  // outlives its list is how a picker ends up eating clicks elsewhere.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [open])

  return (
    <div className="picker" data-picker={name} ref={wrapper}>
      <label className="field inline" htmlFor={inputId}>
        <span>{label}</span>
        <span className="picker-box">
          <input
            id={inputId}
            ref={input}
            className="picker-input"
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            // By position, not by name: a product name is record-controlled
            // text — spaces, slashes, anything — and an id built from it is not
            // one assistive technology can resolve. `item.key` stays the React key.
            aria-activedescendant={open && highlighted ? `${listId}-opt-${activeIndex}` : undefined}
            placeholder={allLabel}
            value={typed}
            disabled={disabled}
            data-picker-value={value ? '1' : undefined}
            onFocus={(event) => {
              setDraft(value)
              setOpen(true)
              setActive(0)
              // Typing replaces rather than appends: the common edit is "a
              // different vendor", not "this vendor plus some letters".
              event.target.select()
            }}
            onClick={() => {
              if (!open) setDraft(value)
              setOpen(true)
            }}
            onChange={(event) => {
              if (!open) setOpen(true)
              setDraft(event.target.value)
              setActive(0)
            }}
            onBlur={() => {
              // A pointer pick fires `pointerdown` on the option before the
              // blur, so the click handler runs first; anything else that
              // moved focus with a changed box commits the text as typed.
              if (!open) return
              setOpen(false)
              if (typed !== value) commit(typed)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (!open) {
                  setDraft(value)
                  setOpen(true)
                }
                setActive((at) => Math.min(at + 1, Math.max(0, items.length - 1)))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((at) => Math.max(at - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                // The highlighted match if the box still leads to one, else the
                // typed text: "cisco" picks Cisco; "acme widgets" is a name the
                // Worker will report as matching nothing, which is the honest
                // answer to a name the copy lacks.
                if (typed.trim() === '') commit(null)
                else if (highlighted) commit(highlighted.label)
                else commit(typed)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setOpen(false)
              }
            }}
          />
          {value !== '' && !disabled && (
            <button
              type="button"
              className="quiet icon picker-clear"
              aria-label={`${label}: any (clear)`}
              title="Any"
              data-picker-clear={name}
              // `preventDefault` on pointerdown keeps focus where it is, so
              // the input's blur (which would commit the typed text first)
              // never fires; the commit itself is on click, which is also
              // what Enter and Space dispatch for a keyboard user.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => commit(null)}
            >
              <ClearIcon />
            </button>
          )}
        </span>
      </label>
      {open && (
        <ul id={listId} className="picker-list" role="listbox" aria-label={`${label} matches`}>
          {loading ? (
            <li
              className="picker-empty muted"
              role="option"
              aria-selected={false}
              aria-disabled="true"
            >
              Loading names…
            </li>
          ) : items.length === 0 ? (
            <li
              className="picker-empty muted"
              role="option"
              aria-selected={false}
              aria-disabled="true"
            >
              {typed.trim() ? 'No name in this copy contains that.' : 'Nothing to list.'}
            </li>
          ) : (
            items.map((item, index) => (
              <li
                key={item.key}
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'picker-option active' : 'picker-option'}
                data-picker-option={item.label}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => {
                  event.preventDefault()
                  commit(item.label)
                }}
              >
                <span className="picker-name">{item.label}</span>
                {item.detail && <span className="picker-detail muted">{item.detail}</span>}
                {item.hint && <span className="picker-hint muted">{item.hint}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

function ClearIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
