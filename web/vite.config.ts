import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import macros from "unplugin-parcel-macros";

export default defineConfig({
  plugins: [macros.vite(), react()],
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
