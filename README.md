# 🔍 RepoForgeAgent

面向前端仓库的代码分析 Agent。用 AST 建立语义图，用 LangGraph 编排分析流水线，LLM 只负责解读——**事实由确定性代码算出**。

```
$ pnpm analyze ./your-project

  ✓ loadRepository            2ms
  ✓ scanFiles              1140ms  1842 个文件
  ✓ detectStack              18ms  Vue + Vite
  ✓ parseSemantic         14210ms  12405 个符号 · 8931 条关系边
  ✓ analyzeArchitecture      96ms  14 个模块
  ✓ dependency               61ms  3 处循环依赖
  ✓ quality                  12ms  维护性评分 72
  ✓ frontend                 88ms  18 个前端问题
  ✓ retrieveContext         143ms  3 条检索结果
  ✓ narrate                4820ms  架构解读已生成
  ✓ render                   74ms  报告已输出
```

## 核心能力

- **语义解析** — ts-morph 建立符号与依赖图，模块解析交给 TypeScript 编译器；自动读取 tsconfig `paths` 与 vite / webpack / rspack / nuxt 的 `resolve.alias`
- **Vue / React 双栈** — Vue SFC 经 `@vue/compiler-sfc` 抽出 script 走同一条 AST 路径；render 关系边分别取自 JSX 与 template
- **依赖分析** — Tarjan 循环依赖检测、环上最优切点（按引用次数最少选取）、模块级依赖图
- **前端专项** — Hooks 疑似条件调用、lint / type 绕过、大文件、维护性评分
- **架构逆向** — 剥离公共前缀后聚合模块、分层推断、Mermaid 架构图
- **语义检索** — 自然语言查询，结构化召回 + 关键词匹配，中文概念映射到代码标识符
- **LLM 解读** — 架构叙述与技术债优先级排序；未配置模型时自动降级为纯确定性分析
- **多种交付** — CLI 实时进度、异步 API + SSE 进度流、React 看板、Markdown / HTML / JSON 报告

## 快速开始

```bash
pnpm install

pnpm analyze ./your-project                              # 分析
pnpm analyze ./your-project --query "处理登录的组件"       # 带语义检索
pnpm analyze ./your-project --json                       # 机器可读输出

pnpm dev                                                 # Web 看板（API + 前端）
pnpm stop                                                # 终止残留进程
```

分析过程**只读扫描目标仓库，不执行目标项目的任何脚本**。产物写入目标仓库的 `.reposurgeon/`：

```
<your-project>/.reposurgeon/
├── index.db          SQLite：历次报告与节点状态快照
└── reports/          report.html / report.md / report.json
```

CLI 与看板是独立进程，通过这个 SQLite 索引打通——看板里填入同一路径即可加载命令行跑出的结果。

## 工作流

```
START → loadRepository → scanFiles → detectStack → parseSemantic
                                                        │
                        ┌───────────────┬───────────────┼───────────────┐
                        ▼               ▼               ▼               ▼
                 analyzeArchitecture  dependency     quality        frontend   ← 并行
                        └───────────────┴───────────────┴───────────────┘
                                                        ▼
                                                 retrieveContext
                                                        ▼
                                                     narrate                   ← 唯一的 LLM 节点
                                                        ▼
                                                      render → END
```

## 配置

全部可选，不配置也能完整运行。

| 环境变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | 启用 LLM 架构解读与查询计划 |
| `OPENAI_BASE_URL` | OpenAI 协议兼容网关（DeepSeek 等） |
| `REPOSURGEON_MODEL` | 默认 `gpt-4o-mini` |
| `REPOSURGEON_API_PORT` | API 端口，默认 `3100` |
| `REPOSURGEON_WEB_PORT` | 看板端口，默认 `5173` |

`@vue/compiler-sfc` 是可选依赖，仅在仓库存在 `.vue` 文件时需要。

## 目录结构

```
src/
├── workflow.ts      LangGraph 编排、State 通道、节点级进度事件
├── scanner.ts       文件扫描、hash、行数、圈复杂度
├── stack.ts         技术栈识别
├── graph.ts         ts-morph 语义解析：符号、依赖边、render 边
├── alias.ts         构建配置里的 resolve.alias 静态提取
├── analyzers.ts     Tarjan 循环依赖、前端专项检查、维护性指标
├── architecture.ts  模块聚合、分层推断、组件拓扑
├── narrate.ts       上下文压缩、环切点计算、LLM 架构解读
├── retrieval.ts     查询计划与混合检索
├── locate.ts        按目录特征反查绝对路径
├── report.ts        Markdown / HTML / JSON 报告
├── storage.ts       SQLite 索引与状态快照
├── llm.ts           模型解析与结构化输出
├── api.ts           异步任务 API + SSE 进度流
└── cli.ts           命令行入口

web/                 React + Vite 分析看板
fixtures/            回归评估用例
scripts/             评估执行器与本地启动脚本
```

## 开发

```bash
pnpm eval          # 回归评估：校验分析器在固定输入上产出的事实
pnpm build         # 类型检查与编译
pnpm format        # 代码格式化
```

## 文档

- [设计决策](docs/DESIGN.md) — 为什么这么做，以及不这么做的代价
- [已知限制](docs/LIMITATIONS.md) — 能力边界与路线图
- [故障排查](docs/TROUBLESHOOTING.md) — 依赖图缺边、改动不生效、端口占用
- [回归评估](fixtures/README.md) — 用例结构与四种结果语义
