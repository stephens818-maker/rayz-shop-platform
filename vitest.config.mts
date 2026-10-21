import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // tsconfig keeps jsx "preserve" for Next; tests that call admin pages need it compiled.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { TZ: "UTC" },
    fileParallelism: false,
  },
});
