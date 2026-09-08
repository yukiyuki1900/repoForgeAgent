# 代码结构

这份文档回答**「现在长什么样」**——模块怎么分、源码在哪、怎么跑起来。
**「为什么变成这样」**在 [DESIGN.md](DESIGN.md)，两者刻意分开：
前者写错了直接改，后者被推翻的判断要保留原话再加指针。

[← 回 README](../README.md)

## 分层

```
                    ┌──────────── 命令行 ────────────┐
                    │  analyze · ask · refactor      │
                    └───────────────┬────────────────┘
                                    │
  scanner ──► graph ──► ┌───────────┴───────────┐
  文件扫描    AST 语义图  │  workflow（LangGraph） │  ◄── Web 看板
                        │  task（SSE 进度 + 归档）│      React + Vite
                        └───────────┬───────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        analyzers             tools + ask            refactor + apply
     Tarjan / 指标 / 死导出    9 个只读工具         import type 拆环 · 死导出清理
                                  ↑   ↓                双层验证 + 回滚
                                  │  模型自主循环
                                  │
                            mcp.ts ──► Claude Code / Cursor
                          同一套工具，标准协议出口
```

| 依赖 | 用途 |
|---|---|
| **ts-morph / TypeScript Compiler API** | 建立符号与依赖图，模块解析交给编译器 |
| **LangGraph** | 分析流水线编排：并行 fan-out / fan-in、条件路由、节点级进度 |
| **Vercel AI SDK** | 结构化输出与工具调用循环 |
| **MCP SDK** | 把工具集通过标准协议交给编辑器 |
| **@vue/compiler-sfc** | 可选依赖，`.vue` 抽出 script 走同一条 AST 路径 |
| **better-sqlite3** | 可选依赖，分析结果索引与任务历史归档；装不上就整体降级，任务照跑 |
| **React + Vite** | Web 看板 |

## 本地开发

```bash
pnpm eval          # 回归评估：校验分析器在固定输入上产出的事实
pnpm test          # 端到端：图真的能跑通、改动真的写盘、MCP 真的能握手
pnpm build         # 类型检查与编译
pnpm format        # 代码格式化
pnpm stop          # 终止残留的开发进程
```

`pnpm eval` 校验判断准不准（fixture 驱动），`pnpm test` 校验动作对不对（真实 git 仓库写盘、桩模型跑工具调用循环、真实 MCP 客户端握手、前后端字段契约）。

`pnpm test` 里还有一组**文档一致性**检查：相对链接是否指向真实文件、下面这棵结构树是否和磁盘完全一致、文档里的 `pnpm <script>` 是否真的存在。**文档腐坏是静默的**——目录重构之后这棵树会立刻变成一张错的地图，而没有任何东西会因此报错：CI 全绿、类型检查通过、所有用例都在跑，它唯一的表现是下一个人照着它去找某个文件，扑了个空。

所以下面这棵树是**被测试锁住的**，双向断言：磁盘上有而这里没列，算错；这里列了而磁盘上没有，也算错。

```
src/
├── workflow.ts          LangGraph 编排、State 通道、条件路由
├── api.ts               HTTP 路由：任务提交与准入、SSE、历史、目录浏览
├── cli.ts               命令行入口
├── mcp.ts               MCP Server：同一套工具的标准协议出口
│
├── core/                跨层的地基，不依赖任何业务模块
│   ├── analysis.ts      分析结果的类型定义
│   ├── plan.ts          意图识别与节点裁剪规则
│   ├── limits.ts        超时、并发、体积上限
│   ├── failure.ts       失败分类：是哪一类、重试有没有用
│   ├── trace.ts         W3C Trace Context 的解析与生成
│   ├── log.ts           结构化日志（每条都带 traceId）
│   └── env.ts           .env / .env.local 加载
│
├── scan/                把仓库变成图
│   ├── scanner.ts       文件扫描、hash、行数、圈复杂度
│   ├── graph.ts         ts-morph 语义解析：符号、依赖边、render 边
│   ├── alias.ts         构建配置里的 resolve.alias 静态提取
│   ├── stack.ts         技术栈识别
│   └── locate.ts        按目录特征反查仓库路径
│
├── analyze/             在图上算事实
│   ├── analyzers.ts     Tarjan 循环依赖、前端专项检查、维护性指标
│   ├── architecture.ts  模块聚合、分层推断、组件拓扑
│   ├── deadexports.ts   没有引用者的导出
│   ├── retrieval.ts     查询计划与混合检索
│   └── facts.ts         给模型看的事实包
│
├── agent/               模型这一侧
│   ├── tools.ts         暴露给模型的只读工具集
│   ├── ask.ts           工具调用循环、流式输出、轮次控制
│   ├── narrate.ts       上下文压缩、环切点计算、架构解读
│   └── llm.ts           模型解析与降级判断
│
├── refactor/            改造与验证
│   ├── refactor.ts      import type 拆环的检测与模拟
│   ├── prune.ts         死导出清理的检测与模拟
│   ├── apply.ts         写入、两层验证、失败回滚与产物留档
│   ├── verify.ts        类型基线对比与重扫对账
│   ├── propose.ts       方案的 schema 约束
│   ├── validate.ts      方案的静态校验
│   ├── execute.ts       方案的执行与对账
│   └── proposalflow.ts  提方案链路的编排
│
├── task/                三种模式共用的任务机制
│   ├── tasks.ts         状态机、去重与准入、SSE 订阅与回放
│   ├── history.ts       任务归档：落库、读取、崩溃后的状态对账
│   └── jobs.ts          三种模式各自的任务体
│
└── report/
    ├── report.ts        md / html / json 三份产物
    └── storage.ts       SQLite 索引读写（可选依赖，拿不到就跳过）

web/src/
├── main.tsx             看板外壳、仓库选择、分析面板
├── AskPanel.tsx         追问面板
├── RefactorPanel.tsx    改造面板
├── TaskHistory.tsx      任务历史列表
├── ActivityLog.tsx      进度时间线
├── Markdown.tsx         流式 Markdown 与代码围栏
├── task.ts              任务客户端：提交、订阅、重连退避、心跳探针
├── sse.ts               SSE 帧解析（fetch + ReadableStream，不是 EventSource）
├── session.ts           taskId 的本地记忆，刷新后接回
├── deeplink.ts          taskId 与模式写进地址栏
├── highlight.ts         轻量语法高亮
├── typewriter.ts        按帧吐字，让流式节奏可控
├── trace.ts             请求发出前生成 traceId
├── ErrorBoundary.tsx    渲染异常兜底
├── types.ts             与后端的字段契约（手写，由测试锁住）
└── demo.ts              离线演示数据

fixtures/            回归评估用例
tests/               端到端与契约测试
.agents/skills/      前端仓库体检的操作手册
```
