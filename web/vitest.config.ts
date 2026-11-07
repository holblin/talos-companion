import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [
      {
        // Macros emit virtual CSS that is not persisted across test-worker restarts.
        // jsdom verifies behavior rather than layout; the production build validates
        // the real generated styles.
        name: "test-macro-css",
        enforce: "pre",
        resolveId(id) {
          return /(?:^|\/)macro-[^/]+\.css$/.test(id)
            ? "\0test-macro-css"
            : null;
        },
        load(id) {
          return id === "\0test-macro-css" ? "" : null;
        },
      },
    ],
    test: {
      server: { deps: { inline: [/@react-spectrum\/s2/] } },
      environment: "jsdom",
      setupFiles: ["./tests/setup.ts"],
      include: ["tests/**/*.test.tsx"],
      environmentOptions: { jsdom: { url: "http://localhost/" } },
      testTimeout: 15_000,
    },
  }),
);
