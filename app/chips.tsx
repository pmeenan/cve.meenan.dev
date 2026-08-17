'use client'

/**
 * The filter chips over the canvas: what the visible result counted, each one
 * removable (M4, kept through the UI polish of 2026-08-16 that retired the
 * filter form they used to sit beside). The state and its conversions live in
 * `lib/draft.ts`, so a permalink and a chat call describe themselves the same
 * way a chip does.
 */

import { clearChip, describeDraft, type Chip, type Draft } from '@/lib/draft'

export function FilterChips({
  draft,
  onChange,
  disabled,
  hide,
}: {
  draft: Draft
  onChange: (draft: Draft) => void
  disabled?: boolean
  /** Chip keys a control beside the row already shows (the canvas's range and pickers). */
  hide?: ReadonlySet<string>
}) {
  const chips = describeDraft(draft).filter((chip) => !hide?.has(chip.key))
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
