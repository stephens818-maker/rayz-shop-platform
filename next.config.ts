import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Squire CSV exports (appointment history) are uploaded through a server action.
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
