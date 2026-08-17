import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TS source directly (no separate build step), so
  // Next.js needs to transpile them itself rather than expecting compiled JS.
  transpilePackages: ["@developer-platform/shared"],
  images: {
    // GitHub's avatar CDN — used for the signed-in user's avatar in the sidebar.
    remotePatterns: [{ protocol: "https", hostname: "avatars.githubusercontent.com" }],
  },
  // NOTE: `output: "standalone"` was tried for a smaller Docker image, but
  // its file-tracing (`@vercel/nft`) doesn't reliably copy every file out of
  // pnpm's content-addressable store in this monorepo (reproducibly missing
  // `@swc/helpers/esm/*` at runtime — a known class of issue with
  // standalone + pnpm). docker/web.Dockerfile instead ships the full pruned
  // `node_modules` and runs `next start`, which is slower to build/larger to
  // ship but actually starts. Worth revisiting if image size becomes a
  // problem in a later phase.
};

export default nextConfig;
