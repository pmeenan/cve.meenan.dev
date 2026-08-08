import { describe, expect, it } from 'vitest'

import { busyMessage, parseTabMessage } from '../../lib/tabs'

/**
 * The cross-tab protocol (M5).
 *
 * `BroadcastChannel` is same-origin, so this is not a trust boundary the way a
 * delta file is. It is still a message from code this tab did not just run —
 * during a deploy, quite possibly from a *different build* — and the one action
 * it triggers is closing the database. A tab that acted on a malformed
 * `promoted` would close its connection on a guess.
 */

describe('parseTabMessage', () => {
  it('accepts the three messages the protocol has', () => {
    expect(parseTabMessage({ type: 'writer', op: 'sync', state: 'start' })).toEqual({
      type: 'writer',
      op: 'sync',
      state: 'start',
    })
    expect(parseTabMessage({ type: 'promoted', rev: 12 })).toEqual({ type: 'promoted', rev: 12 })
    expect(parseTabMessage({ type: 'synced', rev: 12, generated: 99 })).toEqual({
      type: 'synced',
      rev: 12,
      generated: 99,
    })
  })

  it('refuses anything it does not recognise rather than acting on it', () => {
    for (const value of [
      null,
      undefined,
      'promoted',
      42,
      {},
      { type: 'promoted-later' },
      { type: 'writer', op: 'delete', state: 'start' },
      { type: 'writer', op: 'sync', state: 'maybe' },
      // A revision is the one field a `synced` cannot do without: it is what
      // the receiving tab's freshness line becomes.
      { type: 'synced', generated: 99 },
    ]) {
      expect(parseTabMessage(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('treats a missing revision on a promotion as unknown rather than refusing', () => {
    // A promotion happened either way, and the receiving tab's response is to
    // reopen and re-discover — which does not need the number. Refusing here
    // would leave that tab querying a generation nobody else can see.
    expect(parseTabMessage({ type: 'promoted' })).toEqual({ type: 'promoted', rev: null })
  })
})

describe('busyMessage', () => {
  it('names the operation that is already running', () => {
    expect(busyMessage('download')).toContain('downloading')
    expect(busyMessage('sync')).toContain('syncing')
  })

  it('still says something useful when it does not know which', () => {
    // Reachable: this tab never heard the start announcement because it was
    // opened after the other tab began.
    expect(busyMessage(null)).toContain('downloading or syncing')
  })

  it('tells the reader what they can still do, since it is not nothing', () => {
    // Multi-tab is full support (M5's owner decision): the blocked tab keeps
    // querying, and picks up the result when the writer finishes.
    expect(busyMessage('sync')).toContain('keep querying')
  })
})
