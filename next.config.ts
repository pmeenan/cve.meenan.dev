import type { NextConfig } from 'next'

/**
 * Static export only (D-027). There is no Node runtime in production: nginx
 * serves `dist/` and the data plane is static files under /data/ (D-032).
 *
 * `trailingSlash` emits /route/index.html, which the server's existing
 * `try_files $uri $uri/ =404;` already resolves — chosen over editing nginx
 * routing (D-030).
 */
const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'dist',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
}

export default nextConfig
