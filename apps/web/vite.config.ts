import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately (pnpm server); requests are passed on to it.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.SESSIONLY_SERVER ?? "http://127.0.0.1:8080" },
  },
});
