# RepoForgeAgent / Repo Surgeon

面向 React、Vue、Next.js、Nuxt 前端仓库的 LangGraph.js 分析 Agent。确定性分析器建立文件、符号和 import 语义图，LangGraph 负责节点编排、状态传递和 checkpoint，检索层支持结构化查询与 FTS 混合召回。

## 使用

```bash
pnpm install
pnpm build
node dist/cli.js analyze ./your-project
node dist/cli.js analyze ./your-project --json
node dist/cli.js analyze ./your-project --query "找所有处理用户登录的组件"
# API（默认监听 127.0.0.1:3100）
pnpm api
# 前端（另开终端，默认 127.0.0.1:5173；未启动 API 时自动展示 Demo 数据）
pnpm web:dev
```

分析过程只读扫描目标仓库，结果写入目标仓库的 `.reposurgeon/`：SQLite 增量索引和报告。不会执行目标项目脚本。

## 当前能力

- package.json、源码特征和配置无关的基础技术栈识别，结论包含置信度与证据
- TypeScript/JavaScript/Vue 文件扫描、Hash、行数和基础圈复杂度
- 相对 import 图、符号索引、Tarjan 强连通分量循环依赖检测
- React Hooks 疑似条件调用、lint/type 绕过、大文件规则
- SQLite WAL 索引、FTS5 文件检索表
- Mermaid、Markdown、HTML、JSON 报告
- LangGraph.js 工作流：仓库加载、扫描、技术栈、语义解析、架构、依赖、质量、前端专项、检索和报告节点
- SQLite `checkpoints` 表保存分析工作流状态，`thread_id` 对应一次分析执行
- 自然语言查询计划和结构化/文本混合检索，结果包含文件、符号、关系路径和命中原因
- Koa API：`POST /analysis` 返回报告和 Mermaid 字符串，前端可直接交给 Mermaid renderer 渲染；`GET /analysis/:runId` 查询执行结果
- React + Vite 分析看板：技术栈、健康度、风险、语义检索和 Mermaid 架构图

## 后续扩展

当前查询解析使用无外部模型的确定性规则，便于本地运行和测试。下一步可通过 Vercel AI SDK 的 `generateObject` 将自然语言转换为同一份 `QueryPlan`，并接入 embedding 召回；LLM 仍只负责意图解析、风险解释和报告叙述，不参与事实计算。
