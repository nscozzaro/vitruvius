import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  serverExternalPackages: ["potrace", "sharp", "mupdf"],
};

export default nextConfig;
