'use client'

/**
 * The landing view — what a visitor with no local copy sees (UI revamp).
 *
 * Before the first download the app can do nothing but explain itself, so this
 * view is a pitch with one action. Everything it promises is checkable: the
 * privacy claim is D-079's structural one (queries run here, the server sees
 * none of them), and the download size and record count are the published
 * snapshot's own numbers, passed in rather than hard-coded where they would
 * drift.
 *
 * The capability gate and the storage preflight speak *before* the button does
 * anything (D-016, M5): a browser that cannot run the app is told at the top,
 * and the button is disabled rather than allowed to fail tens of seconds in.
 */

export function Landing({
  onDownload,
  disabled,
  busy,
  obsolete,
  hostedError,
  progress,
  children,
}: {
  onDownload: () => void
  /** The gate has fired or a run is underway — the CTA must not start another. */
  disabled: boolean
  busy: boolean
  /** The local copy exists but speaks an older schema — a re-download replaces it. */
  obsolete: boolean
  /**
   * Why the hosted tier is not serving this visit (D-084), or null when it was
   * simply off. This view renders only when neither tier can answer, and the
   * difference between "the server tier is down" and "you asked for local
   * only" is worth a sentence.
   */
  hostedError?: string | null
  /** The shared progress bar, rendered by the page while a download runs. */
  progress?: React.ReactNode
  /** The diagnostics panel, rendered by the page so it exists in every view. */
  children?: React.ReactNode
}) {
  return (
    <div className="landing" data-landing="1">
      <section className="hero">
        <p className="hero-kicker">cve.meenan.dev</p>
        <h2 className="hero-title">Explore the complete CVE List — right here, in your browser.</h2>
        <p className="hero-lede">
          CVE Explorer downloads the entire published CVE corpus — every record MITRE has ever
          issued — into your browser as a local database. Search it, chart it, ask questions about
          it in plain language, and share what you find. After the one download, every query runs on
          your machine.
        </p>

        <div className="hero-cta">
          <button type="button" onClick={onDownload} disabled={disabled} data-download="1">
            {busy ? 'Downloading…' : obsolete ? 'Re-download CVE dataset' : 'Download CVE dataset'}
          </button>
          <p className="muted small">
            One download of about 66&nbsp;MB, stored in this browser. Sync afterwards fetches only
            the day&rsquo;s changes.
          </p>
          {hostedError && (
            <p className="stale small" data-hosted-error="1">
              Normally queries can start on this site&rsquo;s server before any download, but that
              tier is not answering right now ({hostedError}), so the download is the way in.
            </p>
          )}
        </div>

        {progress}
      </section>

      <section className="features" aria-label="What you can do">
        <div className="feature">
          <h3>Ask in plain language</h3>
          <p>
            &ldquo;Stacked CVE counts by severity over time&rdquo; — an AI assistant turns your
            question into a local query and shows the chart, the numbers, and the SQL behind them.
            Opt-in, and only your question and its results ever leave the browser.
          </p>
        </div>
        <div className="feature">
          <h3>Charts built for sharing</h3>
          <p>
            Severity trends, vendor breakdowns, CWE spreads — with editable titles, chart types you
            can switch on the fly, and one-click copy as an image or a table that pastes into docs
            and spreadsheets.
          </p>
        </div>
        <div className="feature">
          <h3>The whole corpus, filterable</h3>
          <p>
            Filter 370,000+ records by vendor, product, CWE, CVSS, SSVC, dates and full text — with
            CISA&rsquo;s Known Exploited Vulnerabilities catalog overlaid, and a raw SQL console
            when you want it.
          </p>
        </div>
        <div className="feature">
          <h3>Private by design</h3>
          {/* The structural claim, and only it (D-079): what the server never
              receives is checkable in a network panel. Not "nothing about you
              is recorded anywhere" — the origin keeps ordinary web-server
              access logs like any site, so the blanket form would be false. */}
          <p>
            The server hands over static files and never sees a search, a filter, or a report — you
            can watch the network panel and check. No accounts and no telemetry in the app; the
            origin keeps only ordinary web-server access logs.
          </p>
        </div>
      </section>

      {children}
    </div>
  )
}
