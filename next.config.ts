import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  serverExternalPackages: ["potrace", "sharp"],
};

export default nextConfig;
