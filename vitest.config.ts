import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    env: {
      LOG_LEVEL: "silent",
    },
    coverage: {
      provider: "v8",
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
});
