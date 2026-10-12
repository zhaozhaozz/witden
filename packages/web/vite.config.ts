import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the API (including the SSE stream) to a locally running backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8320",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // Mermaid's diagram engines (elk, cytoscape, ...) are big but only load when a message contains a
    // diagram; the console's own entry stays under 500 kB.
    chunkSizeWarningLimit: 1600,
  },
});
