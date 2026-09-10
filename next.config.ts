import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "yahoo-finance2"],
  // Hide the Next.js bottom-left / corner N indicator in `next dev`
  devIndicators: false,
};

export default nextConfig;
