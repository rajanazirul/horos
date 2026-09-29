import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static: `npm run build` writes a deployable site to ./out
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
