import { defineConfig, version as viteVersion } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// In dev (`npm run dev`), /api is proxied to a locally running backend.
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __VITE_VERSION__: JSON.stringify(viteVersion),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: { "/api": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000" },
  },
});
