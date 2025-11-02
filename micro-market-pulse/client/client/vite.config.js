import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/signals": "http://localhost:4000",
      "/health": "http://localhost:4000",
    },
  },
});
