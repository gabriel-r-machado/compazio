import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: [
    "@forgedeck/config",
    "@forgedeck/core",
    "@forgedeck/schemas",
    "@forgedeck/ui",
    "@forgedeck/workflow"
  ]
};

export default nextConfig;
