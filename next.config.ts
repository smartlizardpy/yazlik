import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    /**
     * Vercel Blob, for when `STORAGE_DRIVER=blob`.
     *
     * A store's hostname is `<storeId>.public.blob.vercel-storage.com`, so the
     * leading `**` covers whichever store this project ends up with without
     * anyone editing this file again. `search: ""` forbids query strings: our
     * URLs never carry one, and leaving it open lets a stranger's URL be
     * optimised through our server.
     *
     * `remotePatterns`, not `domains` — `domains` has been deprecated since
     * Next 14 because it cannot restrict protocol, port, or path.
     *
     * Nothing is needed for the `local` driver: those images are same-origin
     * paths under `/api/uploads/`, and local paths are allowed by default.
     */
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.public.blob.vercel-storage.com",
        pathname: "/**",
        search: "",
      },
    ],
  },
  experimental: {
    serverActions: {
      /**
       * Photos are capped at 8MB in `lib/storage.ts`, and on the `local` driver
       * they reach the server through a Server Action rather than going
       * straight to a CDN. The default body limit is 1MB, which every real
       * phone photo exceeds. 10MB leaves room for multipart overhead above the
       * 8MB ceiling that does the actual refusing.
       */
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
