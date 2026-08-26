import type { ProgressEvent, Report, RetrievalResult } from "./types";

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
    evidence: ["next dependency", "app/page.tsx", "zustand dependency"],
  },
  files: [
    { path: "app/page.tsx", lineCount: 124, complexity: 9 },
    { path: "features/auth/LoginForm.tsx", lineCount: 286, complexity: 14 },
    { path: "components/ProductCard.tsx", lineCount: 88, complexity: 6 },
    { path: "services/order.ts", lineCount: 164, complexity: 11 },
  ],
  symbols: [
    { name: "LoginForm", kind: "component" },
    { name: "useAuth", kind: "hook" },
    { name: "ProductCard", kind: "component" },
    { name: "createOrder", kind: "function" },
  ],
  edges: [],
  findings: [
    {
      rule: "react-hooks-condition",
      severity: "error",
      message: "疑似在条件分支中调用 Hook，请人工确认",
      files: ["features/auth/LoginForm.tsx"],
    },
    {
      rule: "large-file",
      severity: "warning",
      message: "文件超过 500 行，建议拆分职责",
      files: ["features/auth/LoginForm.tsx"],
    },
    {
      rule: "lint-bypass",
      severity: "warning",
      message: "文件包含 lint/type 检查绕过指令",
      files: ["services/order.ts"],
    },
  ],
  // 维度需与 src/analyzers.ts 的 calculateMetrics 保持一致：
  // 重复代码率与依赖健康度尚未实现，因此不在演示数据中出现
  metrics: { score: 74, dimensions: { complexity: 68, coupling: 61, typing: 94 } },
  narration: {
    summary:
      "这是一个 Next.js App Router 电商前端，页面层通过 features 组织业务模块，公共 UI 收敛在 components，数据访问集中在 services。整体分层清晰，但 features/auth 承担了过多职责。",
    layering: [
      { layer: "pages", role: "路由入口，只做数据编排与布局" },
      { layer: "features", role: "业务功能模块，包含状态与交互逻辑" },
      { layer: "components", role: "无业务语义的通用 UI" },
      { layer: "services", role: "接口访问与数据转换" },
    ],
    risks: [
      {
        title: "LoginForm 同时承担表单、校验与登录流程",
        severity: "high",
        rationale: "文件 286 行、圈复杂度 14，且存在疑似条件调用 Hook",
        suggestion: "把校验规则抽到独立模块，登录流程下沉到 services/auth",
        relatedPaths: ["features/auth/LoginForm.tsx"],
      },
      {
        title: "order 服务绕过了类型检查",
        severity: "medium",
        rationale: "文件包含 lint/type 检查绕过指令，可能掩盖真实的类型不匹配",
        suggestion: "补齐接口返回值类型定义后移除绕过指令",
        relatedPaths: ["services/order.ts"],
      },
    ],
  },
  mermaid:
    "graph TD\n  pages[pages] --> features[features]\n  features --> components[components]\n  features --> services[services]\n  components --> utils[utils]",
  generatedAt: new Date().toISOString(),
};

/** 未连接 API 时展示的节点级进度，与真实事件结构一致 */
export const demoEvents: ProgressEvent[] = [
  { node: "loadRepository", phase: "end", at: "", durationMs: 2 },
  { node: "scanFiles", phase: "end", at: "", durationMs: 1140, detail: "1842 个文件" },
  { node: "detectStack", phase: "end", at: "", durationMs: 18, detail: "Next.js + Turbopack" },
  {
    node: "parseSemantic",
    phase: "end",
    at: "",
    durationMs: 14210,
    detail: "12405 个符号 · 8931 条关系边",
  },
  { node: "analyzeArchitecture", phase: "end", at: "", durationMs: 96, detail: "7 个模块" },
  { node: "dependency", phase: "end", at: "", durationMs: 61, detail: "3 处循环依赖" },
  { node: "quality", phase: "end", at: "", durationMs: 12, detail: "维护性评分 72" },
  { node: "frontend", phase: "end", at: "", durationMs: 88, detail: "3 个前端问题" },
  { node: "retrieveContext", phase: "end", at: "", durationMs: 143, detail: "3 条检索结果" },
  { node: "narrate", phase: "end", at: "", durationMs: 4820, detail: "架构解读已生成" },
  { node: "render", phase: "end", at: "", durationMs: 74, detail: "报告已输出" },
];

export const demoRetrieval: RetrievalResult[] = [
  {
    path: "features/auth/LoginForm.tsx",
    symbol: "LoginForm",
    score: 55,
    reasons: ["符号命中：component", "文本命中：login", "关系命中：uses-hook"],
    relatedPaths: ["hooks/useAuth.ts", "services/auth.ts"],
  },
  {
    path: "hooks/useAuth.ts",
    symbol: "useAuth",
    score: 45,
    reasons: ["符号命中：hook", "文本命中：authentication"],
    relatedPaths: ["stores/session.ts"],
  },
  { path: "services/auth.ts", score: 20, reasons: ["文本命中：session"], relatedPaths: [] },
];
