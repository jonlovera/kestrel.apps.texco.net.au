import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // don't pick up copies of the suite inside git worktrees under .claude/
    exclude: ["**/node_modules/**", ".claude/**"],
    alias: {
      /**
       * `import "server-only"` is a build-time assertion for Next's bundler —
       * it exists to make a client component that imports the module fail to
       * compile. It resolves through Next's own conditions and not through
       * vitest, so without this shim any module carrying the marker cannot be
       * imported by a test at all.
       *
       * That is not hypothetical: it is why lib/write-scope.ts says in its own
       * header that it stays out of lib/api-guard.ts, "because that module is
       * server-only and therefore unreachable from the suite". Aliasing it to
       * an empty module keeps the production guarantee (Next still enforces
       * the boundary at build time) while letting the suite reach the code.
       */
      "server-only": new URL("./test/server-only-shim.ts", import.meta.url).pathname,
    },
  },
});
