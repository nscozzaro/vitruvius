import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  serverExternalPackages: ["sharp", "mupdf"],
};

export default nextConfig;
