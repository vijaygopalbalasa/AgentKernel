// Vitest config for unit tests only
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["tests/**/*"],
    environment: "node",
    testTimeout: 10000,
  },
});
