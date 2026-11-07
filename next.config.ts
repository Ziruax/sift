import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Hide the dev-tools indicator badge — it overlaps the data tables.
  devIndicators: false,
};

export default nextConfig;
