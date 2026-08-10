import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CVE Explorer',
  description:
    'CVE Explorer — browser-based search, analysis and AI chat over the complete CVE List.',
}

/**
 * `connect-src 'self'` — the chat tier's boundary, pinned (M7, D-057).
 *
 * Deliberately narrow. This is not a general CSP hardening pass, which would be
 * its own piece of work with its own breakage surface; it is one directive
 * making one claim enforceable by the browser: **nothing this document fetches
 * can leave this origin.** The site-hosted tier relays to our model host
 * server-side, so a page that could reach any other host is a page that is no
 * longer that tier. M8 adds browser-direct provider traffic (D-045) and will
 * have to widen this — which is the point of pinning it now: that becomes a
 * deliberate one-line diff with a failing test beside it, rather than drift
 * nobody notices.
 *
 * A meta tag rather than a response header because the deploy is an
 * unprivileged rsync (D-003) and the header would be root's file. Two
 * consequences, stated rather than glossed: a meta CSP cannot carry
 * `frame-ancestors`, and it does **not** reach the database Worker, which gets
 * its policy from its own response and therefore has none. Chat runs on the
 * main thread, so the claim this directive makes holds where it is made; the
 * Worker's half needs an nginx header, and `scripts/nginx-chat.conf` carries
 * the line for whenever the server config is next touched.
 */
const CSP = "connect-src 'self'"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
      </head>
      <body>{children}</body>
    </html>
  )
}
