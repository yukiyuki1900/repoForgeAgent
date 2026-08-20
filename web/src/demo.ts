import type { Report, RetrievalResult } from "./types";

export const demoReport: Report = {
  root: "/workspace/demo-shop",
  stack: {
    framework: "Next.js",
    frameworkVersion: "14.x",
    buildTool: "Turbopack",
    stateManagement: ["Zustand"],
    language: ["TypeScript", "JavaScript"],
    router: "Next App Router",
    confidence: 0.96,
    evidence: ["next dependency", "app/page.tsx", "zustand dependency"]
  },
  files: [
    { path: "app/page.tsx", lineCount: 124, complexity: 9 },
    { path: "features/auth/LoginForm.tsx", lineCount: 286, complexity: 14 },
    { path: "components/ProductCard.tsx", lineCount: 88, complexity: 6 },
    { path: "services/order.ts", lineCount: 164, complexity: 11 }
  ],
  symbols: [
    { name: "LoginForm", kind: "component" },
    { name: "useAuth", kind: "hook" },
    { name: "ProductCard", kind: "component" },
    { name: "createOrder", kind: "function" }
  ],
  edges: [],
  findings: [
    { rule: "react-hooks-condition", severity: "error", message: "疑似在条件分支中调用 Hook，请人工确认", files: ["features/auth/LoginForm.tsx"] },
    { rule: "large-file", severity: "warning", message: "文件超过 500 行，建议拆分职责", files: ["features/auth/LoginForm.tsx"] },
    { rule: "lint-bypass", severity: "warning", message: "文件包含 lint/type 检查绕过指令", files: ["services/order.ts"] }
  ],
  // 维度需与 src/analyzers.ts 的 calculateMetrics 保持一致：
  // 重复代码率与依赖健康度尚未实现，因此不在演示数据中出现
  metrics: { score: 74, dimensions: { complexity: 68, coupling: 61, typing: 94 } },
  mermaid: "graph TD\n  pages[pages] --> features[features]\n  features --> components[components]\n  features --> services[services]\n  components --> utils[utils]",
  generatedAt: new Date().toISOString()
};

export const demoRetrieval: RetrievalResult[] = [
  { path: "features/auth/LoginForm.tsx", symbol: "LoginForm", score: 55, reasons: ["符号命中：component", "文本命中：login", "关系命中：uses-hook"], relatedPaths: ["hooks/useAuth.ts", "services/auth.ts"] },
  { path: "hooks/useAuth.ts", symbol: "useAuth", score: 45, reasons: ["符号命中：hook", "文本命中：authentication"], relatedPaths: ["stores/session.ts"] },
  { path: "services/auth.ts", score: 20, reasons: ["文本命中：session"], relatedPaths: [] }
];
