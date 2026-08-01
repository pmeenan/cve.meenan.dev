import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'cve.meenan.dev',
  description: 'Browser-based search and analysis over the complete CVE List.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
