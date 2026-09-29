import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A package-lock.json also exists above this repository on the development
  // machine. Pinning the root keeps Turbopack's resolver and watcher inside the
  // application, which matches the deployment layout and makes local builds deterministic.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
