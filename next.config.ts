import type { NextConfig } from "next";

// Standalone output powers the sandbox's `bun run start`; Netlify wants the
// standard build layout which @netlify/plugin-nextjs processes into functions.
const nextConfig: NextConfig = {
  ...(process.env.NETLIFY ? {} : { output: "standalone" }),
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Hide the dev-tools indicator badge — it overlaps the data tables.
  devIndicators: false,
};

export default nextConfig;
