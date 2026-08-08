'use client'

/**
 * The tabbed workspace (M4's shape decision).
 *
 * One route, five panels. The reason is not layout: the Worker owns SQLite on
 * OPFS, and reopening the database costs the 3.4 s measured in D-049 — so a
 * real route change would make every navigation pay for a reopen, and a
 * long-running import would be killed by clicking a link. Tabs keep the Worker
 * mounted because nothing unmounts.
 *
 * Panels stay in the DOM and are hidden with `hidden`, rather than being
 * unmounted. A half-built report survives a trip to the SQL tab, which is what
 * anyone would expect; `hidden` also takes them out of the accessibility tree
 * and out of the tab order, so the cost is DOM nodes rather than confusion.
 *
 * The keyboard contract is the ARIA authoring practices' tablist: one tab stop
 * for the whole list (roving `tabindex`), left/right to move between tabs,
 * Home/End to the ends, and moving focus activates. Hand-written tests cover
 * exactly this, because no rule engine checks that arrow keys work — axe-core
 * can only see that the roles and names are there.
 */

import { useCallback, useRef, type KeyboardEvent } from 'react'

export interface TabSpec {
  id: string
  label: string
  /** Shown in the tab as a quiet count or state, e.g. the number of saved reports. */
  badge?: string
  /** A tab that exists but cannot be used yet — with the reason as its title. */
  disabled?: boolean
  disabledReason?: string
}

export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: TabSpec[]
  active: string
  onSelect: (id: string) => void
}) {
  const listRef = useRef<HTMLDivElement | null>(null)

  const move = useCallback(
    (from: number, delta: number) => {
      const usable = tabs.filter((tab) => !tab.disabled)
      if (usable.length === 0) return
      const at = usable.findIndex((tab) => tab.id === tabs[from]?.id)
      // A disabled tab is not a stop: from one, the arrow keys still land on
      // something usable rather than doing nothing.
      const base = at === -1 ? 0 : at
      const next = usable[(base + delta + usable.length) % usable.length]!
      onSelect(next.id)
      focusTab(listRef.current, next.id)
    },
    [tabs, onSelect]
  )

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        move(index, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        move(index, -1)
        break
      case 'Home': {
        event.preventDefault()
        const first = tabs.find((tab) => !tab.disabled)
        if (first) {
          onSelect(first.id)
          focusTab(listRef.current, first.id)
        }
        break
      }
      case 'End': {
        event.preventDefault()
        const last = [...tabs].reverse().find((tab) => !tab.disabled)
        if (last) {
          onSelect(last.id)
          focusTab(listRef.current, last.id)
        }
        break
      }
    }
  }

  return (
    <div className="tabs" role="tablist" aria-label="Workspace" ref={listRef}>
      {tabs.map((tab, index) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            // Roving tabindex: exactly one tab is in the page's tab order, so
            // Tab moves past the whole list rather than through five stops.
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            title={tab.disabled ? tab.disabledReason : undefined}
            data-tab={tab.id}
            className={selected ? 'tab selected' : 'tab'}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
            {/* Hidden from the accessibility tree on purpose: a tab's name is
                how it is addressed, and a name that changes as data changes —
                "Saved" becoming "Saved 3" — renames a navigation control
                underneath whoever is using it. The count is a sighted
                convenience; the panel itself states it. */}
            {tab.badge && (
              <span className="tab-badge" aria-hidden="true">
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function focusTab(list: HTMLElement | null, id: string): void {
  const target = list?.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(id)}"]`)
  target?.focus()
}

export function TabPanel({
  id,
  active,
  children,
}: {
  id: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <div
      id={`panel-${id}`}
      role="tabpanel"
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      // Focusable so that Tab out of the tablist lands inside the panel it
      // selected, which is what the authoring practices ask for when a panel
      // does not begin with a focusable element of its own.
      tabIndex={active ? 0 : -1}
      data-panel={id}
    >
      {children}
    </div>
  )
}
