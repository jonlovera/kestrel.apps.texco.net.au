import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // don't pick up copies of the suite inside git worktrees under .claude/
    exclude: ["**/node_modules/**", ".claude/**"],
  },
});
