/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export only when building for Electron packaging; `next dev` keeps server features.
  output: process.env.NEXT_EXPORT ? 'export' : undefined,
  trailingSlash: true,
  images: { unoptimized: true },
}

export default nextConfig
