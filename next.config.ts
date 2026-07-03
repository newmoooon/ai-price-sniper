import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray lockfile exists higher up the filesystem; pin the workspace
  // root so Next/Turbopack doesn't infer the wrong one.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
