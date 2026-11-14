import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-01",
        r2Buckets: ["UPLOADS"],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
