// Vitest config for chaos tests
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/chaos/**/*.test.ts"],
    exclude: ["src/**/*"],
    environment: "node",
    testTimeout: 180000,
    hookTimeout: 180000,
    setupFiles: ["tests/chaos/setup.ts"],
    pool: "forks",
    maxConcurrency: 1,
    isolate: true,
    reporters: ["verbose"],
  },
});
