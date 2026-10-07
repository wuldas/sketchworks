import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["@salusoft89/planegcs"] },
  server: {
    host: "127.0.0.1",
    watch: {
      ignored: [
        /(^|[\\/])artifacts([\\/]|$)/,
        /(^|[\\/])[^\\/]*\.tmpdir([\\/]|$)/,
      ],
    },
  },
});
