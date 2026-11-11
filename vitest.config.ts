import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Node environment is correct for pure-function tests. Anything that
    // touches the DOM (PixiJS, React) belongs in a separate jsdom suite,
    // which we don't have yet — keep it that way until we genuinely need
    // it; jsdom inflates CI time disproportionately to the value.
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".next", "out", "dist-electron"],
  },
})
