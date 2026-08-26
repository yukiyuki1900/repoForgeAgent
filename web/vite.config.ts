import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * dev server 把 API 路径代理到本地后端。
 *
 * 每加一个后端路由都必须在这里登记，否则请求会被 vite 当成前端路由
 * 返回 index.html——表现是「拿到 200，但 JSON.parse 报 Unexpected token <」，
 * 排查起来很费时间。
 */
const API = "http://127.0.0.1:3100";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/analysis": API,
      "/refactor": API,
      "/ask": API,
      // 三种模式共用的任务状态与 SSE 进度流
      "/tasks": API,
      // 目录浏览与历史记录
      "/fs": API,
      "/repo": API,
    },
  },
});
