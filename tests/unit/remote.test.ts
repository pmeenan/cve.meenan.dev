/**
 * The hosted query tier's client half (D-084, lib/remote.ts).
 *
 * Everything decidable without a network is pure and tested here: how an HTTP
 * outcome becomes a result or a readable refusal, the request bounds, and how
 * the database-shaped shim maps `exec`/`selectValue` calls onto the envelope.
 * The Worker's use of the shim is exercised in e2e (`hosted.spec.ts`); the
 * PHP end is held equal by `hosted-parity.test.ts` and verified for real by
 * `scripts/verify-sql-php.sh`.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_REMOTE_PARAMS,
  MAX_REMOTE_ROWS,
  MAX_REMOTE_SQL_CHARS,
  RemoteDb,
  isRemoteDb,
  parseRemoteResponse,
  remoteEnvelope,
} from '../../lib/remote'

const OK_BODY = JSON.stringify({
  columns: ['a', 'b'],
  rows: [
    [1, 'x'],
    [2, 'y'],
  ],
  truncated: false,
  ms: 7,
})

describe('parseRemoteResponse', () => {
  it('returns the result on 200', () => {
    const result = parseRemoteResponse(200, OK_BODY)
    expect(result.columns).toEqual(['a', 'b'])
    expect(result.rows).toEqual([
      [1, 'x'],
      [2, 'y'],
    ])
    expect(result.truncated).toBe(false)
    expect(result.ms).toBe(7)
  })

  it('passes a server error message through verbatim', () => {
    const body = JSON.stringify({ error: 'this endpoint is read-only: INSERT is refused' })
    expect(() => parseRemoteResponse(200, body)).toThrow(/read-only: INSERT/)
  })

  it('maps 429 to a wait message, not a failure', () => {
    expect(() => parseRemoteResponse(429, '')).toThrow(/busy right now/)
  })

  it('maps 503 to unavailability', () => {
    expect(() => parseRemoteResponse(503, '')).toThrow(/temporarily unavailable/)
  })

  it('maps status 0 to unreachable', () => {
    expect(() => parseRemoteResponse(0, '')).toThrow(/could not be reached/)
  })

  it('names the status for anything else', () => {
    expect(() => parseRemoteResponse(418, '')).toThrow(/HTTP 418/)
  })

  it('refuses a body that is not JSON, without echoing it', () => {
    // The dev server serves the PHP source as bytes — this is the exact shape
    // a local session sees, and it must fail closed rather than render PHP.
    expect(() => parseRemoteResponse(200, '<?php echo "nope";')).toThrow(/not a result/)
    try {
      parseRemoteResponse(200, '<?php secret')
    } catch (error) {
      expect(String(error)).not.toContain('secret')
    }
  })

  it('refuses a JSON body of the wrong shape', () => {
    expect(() => parseRemoteResponse(200, '{"columns": "nope", "rows": []}')).toThrow(
      /not a result/
    )
    expect(() => parseRemoteResponse(200, '{"columns": [], "rows": [1]}')).toThrow(/not a result/)
    expect(() => parseRemoteResponse(200, 'null')).toThrow(/not a result/)
  })

  it('defaults ms to 0 when the field is missing or unusable', () => {
    const body = JSON.stringify({ columns: [], rows: [], truncated: true })
    expect(parseRemoteResponse(200, body).ms).toBe(0)
    expect(parseRemoteResponse(200, body).truncated).toBe(true)
  })

  it('carries overflowed distinctly from truncated (D-078)', () => {
    const capped = JSON.stringify({ columns: ['a'], rows: [[1]], truncated: true })
    expect(parseRemoteResponse(200, capped).overflowed).toBe(false)
    const over = JSON.stringify({
      columns: ['a'],
      rows: [[1]],
      truncated: true,
      overflowed: true,
    })
    expect(parseRemoteResponse(200, over).overflowed).toBe(true)
  })
})

describe('remoteEnvelope', () => {
  it('carries sql, params and a clamped limit', () => {
    const body = JSON.parse(remoteEnvelope('SELECT 1', ['a', 2], 50))
    expect(body).toEqual({ sql: 'SELECT 1', params: ['a', 2], limit: 50 })
  })

  it('clamps the limit into [1, MAX_REMOTE_ROWS]', () => {
    expect(JSON.parse(remoteEnvelope('SELECT 1', [], 0)).limit).toBe(1)
    expect(JSON.parse(remoteEnvelope('SELECT 1', [], 10 ** 9)).limit).toBe(MAX_REMOTE_ROWS)
    expect(JSON.parse(remoteEnvelope('SELECT 1', [], 12.7)).limit).toBe(12)
  })

  it('refuses oversized SQL with a readable message', () => {
    expect(() => remoteEnvelope('x'.repeat(MAX_REMOTE_SQL_CHARS + 1), [], 1)).toThrow(/too long/)
  })

  it('refuses too many parameters', () => {
    const params = Array.from({ length: MAX_REMOTE_PARAMS + 1 }, () => 1)
    expect(() => remoteEnvelope('SELECT 1', params, 1)).toThrow(/too many values/)
  })
})

/**
 * A synchronous-XHR double, the shape `remoteQuery` drives: `open` with
 * async=false, one `send`, then `status`/`responseText`. Each instance
 * records what was sent so the assertions read like the envelope contract.
 */
function fakeXhr(answer: { status: number; body: string }) {
  const sent: { method?: string; url?: string; async?: boolean; body?: string }[] = []
  class FakeXMLHttpRequest {
    status = 0
    responseText = ''
    timeout = 0
    private request: { method?: string; url?: string; async?: boolean; body?: string } = {}
    open(method: string, url: string, async?: boolean) {
      this.request = { method, url, async }
    }
    setRequestHeader() {}
    send(body?: string) {
      this.request.body = body
      sent.push(this.request)
      this.status = answer.status
      this.responseText = answer.body
    }
  }
  return { FakeXMLHttpRequest, sent }
}

function withXhr<T>(answer: { status: number; body: string }, work: () => T) {
  const { FakeXMLHttpRequest, sent } = fakeXhr(answer)
  const previous = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest
  ;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXMLHttpRequest
  try {
    return { value: work(), sent }
  } finally {
    ;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = previous
  }
}

describe('RemoteDb', () => {
  it('is recognisable and carries no engine handle', () => {
    const db = new RemoteDb()
    expect(isRemoteDb(db)).toBe(true)
    expect(db.pointer).toBeUndefined()
    expect(isRemoteDb({})).toBe(false)
    expect(isRemoteDb(null)).toBe(false)
  })

  it('sends one synchronous POST per exec and feeds rows to the callback', () => {
    const rows: unknown[][] = []
    const columns: string[] = []
    const { sent } = withXhr({ status: 200, body: OK_BODY }, () => {
      new RemoteDb().exec({
        sql: 'SELECT a, b FROM t WHERE x = ?',
        bind: ['v'],
        rowMode: 'array',
        columnNames: columns,
        callback: (row) => {
          rows.push(row as unknown[])
        },
      })
    })
    expect(sent).toHaveLength(1)
    const request = sent[0]!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/api/sql.php')
    expect(request.async).toBe(false)
    expect(JSON.parse(request.body ?? '')).toMatchObject({
      sql: 'SELECT a, b FROM t WHERE x = ?',
      params: ['v'],
    })
    expect(columns).toEqual(['a', 'b'])
    expect(rows).toEqual([
      [1, 'x'],
      [2, 'y'],
    ])
  })

  it('hands the first column per row under rowMode 0, and stops on false', () => {
    const seen: unknown[] = []
    withXhr({ status: 200, body: OK_BODY }, () => {
      new RemoteDb().exec({
        sql: 'SELECT a FROM t',
        rowMode: 0,
        callback: (value) => {
          seen.push(value)
          return false
        },
      })
    })
    expect(seen).toEqual([1])
  })

  it('selectValue returns the first cell of the first row, capped at one row', () => {
    const { value, sent } = withXhr({ status: 200, body: OK_BODY }, () =>
      new RemoteDb().selectValue("SELECT v FROM meta WHERE k = 'rev'")
    )
    expect(value).toBe(1)
    expect(JSON.parse(sent[0]!.body ?? '').limit).toBe(1)
  })

  it('refuses the string form of exec — maintenance paths never run remotely', () => {
    expect(() => new RemoteDb().exec('BEGIN')).toThrow(/structured options/)
  })

  it('turns a server refusal into a thrown, readable error', () => {
    expect(() =>
      withXhr(
        { status: 200, body: '{"error":"this endpoint is read-only: PRAGMA is refused"}' },
        () => new RemoteDb().selectValue('PRAGMA query_only=OFF')
      )
    ).toThrow(/read-only: PRAGMA/)
  })
})
