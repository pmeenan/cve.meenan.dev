'use client'

/**
 * One record, in full (M4).
 *
 * This is the first surface to render the two sections D-033 argued into the
 * schema — affected version ranges and references — and it is also the one
 * surface where the corpus's hostility is a rendering problem rather than a
 * query problem.
 *
 * **A reference URL is attacker-supplied.** Whoever filed the record chose it.
 * So it is held to a scheme allowlist (`lib/sanitize.ts`), shown with its host
 * beside it so the destination is legible before the click, and never
 * auto-fetched — no favicon, no preview, no prefetch. `rel="noreferrer"` and
 * `referrerPolicy="no-referrer"` mean following one does not tell the
 * destination which record the reader was looking at, which is D-011's referrer
 * concern. A URL that fails the allowlist renders as text with the reason,
 * rather than silently disappearing: an omitted reference is a fact about the
 * record the reader should have.
 *
 * **Everything else is a text node.** React escapes it; the point is that
 * nothing downstream un-escapes it (rule 4).
 */

import { useEffect, useRef } from 'react'

import { VERSION_STATUS } from '@/lib/detail'
import { CVSS_VERSION_LABELS, SEVERITY_LABELS, STATE_LABELS, STATE_REJECTED } from '@/lib/filters'
import type { CveDetail, DetailVersion } from '@/lib/protocol'
import { safeUrl } from '@/lib/sanitize'

export function Detail({
  cveId,
  detail,
  onClose,
}: {
  cveId: string
  /** Undefined while being read; null when the Worker found no such record. */
  detail: CveDetail | null | undefined
  onClose: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    // Opening a detail view moves the reader somewhere new, and a keyboard or
    // screen-reader user has no way to know that unless focus goes there.
    headingRef.current?.focus()
  }, [cveId])

  return (
    <section className="detail" aria-labelledby="detail-heading" data-detail={cveId}>
      <div className="detail-head">
        <h3 id="detail-heading" tabIndex={-1} ref={headingRef}>
          {detail?.record.cve ?? cveId}
        </h3>
        <button type="button" className="quiet" onClick={onClose}>
          Close record
        </button>
      </div>

      {detail === undefined ? (
        <p className="muted" data-detail-loading="1">
          Reading this record from the local copy…
        </p>
      ) : detail === null ? (
        <p className="muted" data-detail-missing="1">
          No record in this copy carries that identifier. It may be newer than your last sync, or it
          may not exist.
        </p>
      ) : (
        <div data-detail-loaded="1">
          {detail.record.state === STATE_REJECTED && (
            <p className="stale" data-detail-rejected="1">
              This CVE ID is <strong>REJECTED</strong> — a withdrawn identifier, not a vulnerability
              (D-022).
            </p>
          )}

          <dl className="timings">
            <dt>State</dt>
            <dd>{label(STATE_LABELS, detail.record.state)}</dd>
            <dt>Published</dt>
            <dd>{day(detail.record.published)}</dd>
            <dt>Last updated</dt>
            <dd>{day(detail.record.updated)}</dd>
            <dt>Assigned by</dt>
            <dd>{detail.record.cna ?? '(not recorded)'}</dd>
            <dt>CVSS</dt>
            <dd>
              {detail.record.score === null
                ? 'never scored'
                : `${detail.record.score} ${label(SEVERITY_LABELS, detail.record.severity)} (${label(
                    CVSS_VERSION_LABELS,
                    detail.record.cvssVersion
                  )})`}
            </dd>
            {detail.record.vector && (
              <>
                <dt>Vector</dt>
                <dd className="mono">{detail.record.vector}</dd>
              </>
            )}
          </dl>

          <h4>Description</h4>
          {detail.record.description === null ? (
            // D-023: 4.46% of records carry no English description at all.
            // "No description" and "empty box" have to look different.
            <p className="muted" data-no-description="1">
              This record carries no English description. The corpus stores English only, so a
              record described in another language imports with none.
            </p>
          ) : (
            <p className="descr">{detail.record.description}</p>
          )}

          {detail.cwes.length > 0 && (
            <>
              <h4>Weaknesses</h4>
              <ul className="plain">
                {detail.cwes.map((entry) => (
                  <li key={entry.cwe}>
                    <span className="mono">{entry.cwe}</span> {entry.descr}
                  </li>
                ))}
              </ul>
            </>
          )}

          {detail.products.length > 0 && (
            <>
              <h4>Affected products</h4>
              <ul className="plain columns">
                {detail.products.map((entry, at) => (
                  <li key={`${entry.vendor}/${entry.product}/${at}`}>
                    {entry.vendor} / {entry.product}
                  </li>
                ))}
              </ul>
            </>
          )}

          {detail.versions.length > 0 && (
            <>
              <h4>Version ranges</h4>
              <div className="scroll" tabIndex={0}>
                <table className="results">
                  <thead>
                    <tr>
                      <th scope="col">Vendor</th>
                      <th scope="col">Product</th>
                      <th scope="col">Status</th>
                      <th scope="col">Versions</th>
                      <th scope="col">Scheme</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.versions.map((entry, at) => (
                      <tr key={at}>
                        <td>{entry.vendor}</td>
                        <td>{entry.product}</td>
                        <td>
                          {entry.status === null
                            ? ''
                            : (VERSION_STATUS[entry.status] ?? entry.status)}
                        </td>
                        <td className="mono">{versionRange(entry)}</td>
                        <td>{entry.vtype ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {detail.references.length > 0 && (
            <>
              <h4>References</h4>
              <p className="muted">
                These URLs come from the record and were chosen by whoever filed it. Nothing here is
                fetched — the host is shown so you can see where a link goes before following it.
              </p>
              <ul className="plain refs">
                {detail.references.map((entry, at) => (
                  <Reference key={`${entry.url}-${at}`} url={entry.url} host={entry.host} />
                ))}
              </ul>
            </>
          )}

          {detail.truncated.length > 0 && (
            <p className="stale" data-detail-capped="1">
              This record has more {detail.truncated.join(', ')} than are shown; the list was
              capped.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

/** One reference, linked only if its scheme is allowed (`lib/sanitize.ts`). */
function Reference({ url, host }: { url: string; host: string }) {
  const safe = safeUrl(url)
  if (safe.href === null) {
    return (
      <li data-ref-refused="1">
        <span className="mono">{url}</span>{' '}
        <span className="muted">— not linked: {safe.refused}</span>
      </li>
    )
  }
  return (
    <li>
      <a
        href={safe.href}
        // Every one of these is load-bearing. `noreferrer` keeps the record the
        // reader was on out of the destination's logs (D-011); `noopener` keeps
        // the destination from reaching back into this tab; `no-referrer`
        // repeats the first for browsers that honour the policy and not the
        // rel. Nothing prefetches, because nothing here asks it to.
        rel="noreferrer noopener nofollow"
        referrerPolicy="no-referrer"
        target="_blank"
      >
        {url}
      </a>{' '}
      <span className="muted">({safe.host || host})</span>
    </li>
  )
}

/**
 * A version row in one string.
 *
 * Formatted here rather than in SQL so that which of the four shapes a row is —
 * an exact version, a `<` bound, a `<=` bound, or a bare status — stays visible.
 * The ambiguity `affected[].defaultStatus` would resolve is not in the schema
 * until D-070 lands in M5, so this deliberately does not guess.
 */
function versionRange(entry: DetailVersion): string {
  const from =
    entry.version && entry.version !== '0' ? entry.version : entry.version === '0' ? '0' : ''
  if (entry.lt) return from ? `${from} ≤ v < ${entry.lt}` : `v < ${entry.lt}`
  if (entry.lte) return from ? `${from} ≤ v ≤ ${entry.lte}` : `v ≤ ${entry.lte}`
  return from || '(unspecified)'
}

function label(labels: Record<number, string>, code: number | null): string {
  return code === null ? '(not recorded)' : (labels[code] ?? String(code))
}

function day(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '(not recorded)'
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}
