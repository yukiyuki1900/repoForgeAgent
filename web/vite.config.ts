import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/analysis": "http://127.0.0.1:3100",
      // 目录浏览与历史记录也走同一个本地 API
      "/fs": "http://127.0.0.1:3100",
      "/repo": "http://127.0.0.1:3100"
    }
  }
});
