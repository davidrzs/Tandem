import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/trpc": "http://localhost:3001",
      "/api/auth": "http://localhost:3001",
    },
  },
});
