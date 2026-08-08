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
import {
  CVSS_VERSION_LABELS,
  NOT_ASSESSED_LABEL,
  SEVERITY_LABELS,
  SSVC_AUTO_LABELS,
  SSVC_EXPL_LABELS,
  SSVC_IMPACT_LABELS,
  STATE_LABELS,
  STATE_REJECTED,
} from '@/lib/filters'
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

          {/* The title carries the sink and the vulnerability class that the
              prose buries, so it reads as a heading rather than as one more
              row of the table below (D-070). Record content, rendered as a
              text node like everything else. */}
          {detail.record.title && (
            <p className="detail-title" data-detail-title="1">
              {detail.record.title}
            </p>
          )}

          <dl className="facts">
            <dt>State</dt>
            <dd>{label(STATE_LABELS, detail.record.state)}</dd>
            <dt>Reserved</dt>
            <dd>{day(detail.record.reserved)}</dd>
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

          {/* SSVC (D-070). Rendered as one group with all three points, and
              **always rendered** — including when the record has no assessment
              at all, which is what 51.9% of the corpus looks like. Hiding the
              section for those would make "not assessed" and "we do not show
              this" the same on screen. */}
          <h4>Exploitation (SSVC)</h4>
          <dl className="facts" data-ssvc={detail.record.ssvcExpl === null ? 'absent' : 'present'}>
            <dt>Exploitation</dt>
            <dd>{ssvc(SSVC_EXPL_LABELS, detail.record.ssvcExpl)}</dd>
            <dt>Automatable</dt>
            <dd>{ssvc(SSVC_AUTO_LABELS, detail.record.ssvcAuto)}</dd>
            <dt>Technical impact</dt>
            <dd>{ssvc(SSVC_IMPACT_LABELS, detail.record.ssvcImpact)}</dd>
          </dl>
          {detail.record.ssvcExpl === null &&
            detail.record.ssvcAuto === null &&
            detail.record.ssvcImpact === null && (
              <p className="muted" data-ssvc-absent="1">
                Nobody has published an SSVC assessment for this record. That is an absence, not a
                finding of &ldquo;none&rdquo; — about half the corpus is in this state.
              </p>
            )}

          {detail.record.reason !== null && (
            <>
              <h4>Reason for rejection</h4>
              <p className="descr" data-detail-reason="1">
                {detail.record.reason}
              </p>
            </>
          )}

          <h4>Description</h4>
          {detail.record.description === null ? (
            // D-023: 4.46% of records carry no English description at all —
            // and every REJECTED record is one of them, which is what `reason`
            // above exists to answer (D-070). "No description" and "empty box"
            // have to look different.
            <p className="muted" data-no-description="1">
              This record carries no English description. The corpus stores English only, so a
              record described in another language imports with none.
              {detail.record.reason !== null && ' The reason it was rejected is above.'}
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
                    {entry.defaultStatus !== null && (
                      <span className="muted">
                        {' '}
                        — everything else {VERSION_STATUS[entry.defaultStatus] ?? ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {detail.versions.length > 0 && (
            <>
              <h4>Version ranges</h4>
              {/* Without the last column these rows cannot be read: a record
                  whose default is `affected` lists its *fixed* versions as
                  `unaffected`, so the listed rows are the exceptions rather
                  than the vulnerable set (D-070). */}
              <p className="muted">
                Each row is one range the record listed. &ldquo;Everything else&rdquo; is the status
                the record gives to versions it does not list — without it, a list of
                &ldquo;unaffected&rdquo; rows can mean the opposite of what it looks like.
              </p>
              <div className="scroll" tabIndex={0}>
                <table className="results">
                  <thead>
                    <tr>
                      <th scope="col">Vendor</th>
                      <th scope="col">Product</th>
                      <th scope="col">Status</th>
                      <th scope="col">Versions</th>
                      <th scope="col">Scheme</th>
                      <th scope="col">Everything else</th>
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
                        <td>
                          {entry.defaultStatus === null
                            ? '(not stated)'
                            : (VERSION_STATUS[entry.defaultStatus] ?? entry.defaultStatus)}
                        </td>
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
 * What the row does *not* say is what governs versions outside it; that is
 * `default_status`, and it is its own column rather than folded in here, so a
 * record that states no default reads as "(not stated)" instead of as a guess
 * (D-070).
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

/**
 * An SSVC decision point. Null is named "(not assessed)" rather than
 * "(not recorded)": nobody looked, which is different from `none`, and it is
 * the distinction D-070 turns on.
 */
function ssvc(labels: Record<number, string>, code: number | null): string {
  return code === null ? NOT_ASSESSED_LABEL : (labels[code] ?? String(code))
}

function day(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '(not recorded)'
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}
