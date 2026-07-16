import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next allows only one dev server per dist dir. The Playwright e2e stack
  // runs a second dev server (port 3100) from this directory, so it gets its
  // own dist dir via NEXT_DIST_DIR (see frontend/playwright.config.ts) and
  // never collides with the live dev server's .next.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
