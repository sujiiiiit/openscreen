import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    // Node environment is correct for pure-function tests. Anything that
    // touches the DOM (Konva, React) belongs in a separate jsdom suite,
    // which we don't have yet — keep it that way until we genuinely need
    // it; jsdom inflates CI time disproportionately to the value.
    environment: "node",
    include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
    exclude: ["node_modules", "dist", ".next", "out", "dist-electron"],
  },
})
