import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  // 部署基路径：本应用部署在 https://www.ilili.me/sketch/ 子路径下，故默认使用 "/sketch/"。
  // 如需改为根路径部署，构建时传入 VITE_BASE=/ 覆盖。
  base: process.env.VITE_BASE || "/sketch/",
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
