import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  test: {
    environment: "node",
    // Server Actions live in app/_actions and are tested with @/db mocked, so
    // they belong to the same node-environment run as lib.
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
});
