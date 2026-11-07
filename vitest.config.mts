import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // tsconfig keeps jsx "preserve" for Next; tests that call admin pages need it compiled.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The time clock fails closed without its signing key; tests that check that unset it themselves.
    env: { TZ: "UTC", CLOCK_HMAC_SECRET: "test-only-clock-signing-key-0123456789abcdef" },
    fileParallelism: false,
    // The on-disk module cache keys on a file's own text, so the `import.meta.glob` of admin pages in
    // tests/db/render.ts kept serving the old page list after a page was added.
    fsModuleCache: false,
  },
});
