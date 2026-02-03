// Vitest config for integration tests
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), ".");

export default defineConfig({
  test: {
    root: rootDir,
    dir: "tests/integration",
    include: ["**/*.test.ts"],
    exclude: ["src/**/*"],
    environment: "node",
    testTimeout: 120000, // Integration tests need more time
    hookTimeout: 120000,
    setupFiles: ["tests/integration/setup.ts"],
    // Run tests sequentially to avoid resource conflicts
    pool: "threads",
    maxWorkers: 1,
    maxConcurrency: 1,
    fileParallelism: false,
    // Shared environment to avoid duplicated infra setup
    isolate: false,
    // Provide helpful output
    reporters: ["verbose"],
  },
});
