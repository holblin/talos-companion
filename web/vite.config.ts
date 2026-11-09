import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import macros from "unplugin-parcel-macros";
import optimizeLocales from "@react-aria/optimize-locales-plugin";

export default defineConfig({
  plugins: [
    { ...optimizeLocales.vite({ locales: ["en-US"] }), enforce: "pre" },
    macros.vite(),
    react(),
  ],
  build: {
    target: "es2022",
    cssMinify: "lightningcss",
    cssCodeSplit: false,
  },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/oauth", "/.well-known", "/healthz"].map((path) => [
        path,
        "http://127.0.0.1:8080",
      ]),
    ),
  },
});
