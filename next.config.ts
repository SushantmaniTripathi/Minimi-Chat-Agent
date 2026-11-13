import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app streams responses from dynamic API routes (chat, search) — that's
  // the opposite of what cacheComponents/PPR optimize for, so it stays off.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
