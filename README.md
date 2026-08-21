# RepoForgeAgent / Repo Surgeon

面向前端仓库的代码分析 Agent。用 AST 建立语义图，用 LangGraph 编排分析流水线，用 LLM 解释结果——**事实由确定性代码算出，LLM 只负责解读**。

```
$ reposurgeon analyze ./your-project

  ✓ loadRepository            2ms
  ✓ scanFiles              1140ms  1842 个文件
  ✓ detectStack              18ms  Next.js + Webpack
  ✓ parseSemantic         14210ms  12405 个符号 · 8931 条关系边
  ✓ analyzeArchitecture      96ms  7 个模块
  ✓ dependency               61ms  3 处循环依赖
  ✓ quality                  12ms  维护性评分 72
  ✓ frontend                 88ms  3 个前端问题
  ✓ retrieveContext         143ms  3 条检索结果
  ✓ narrate                4820ms  架构解读已生成
  ✓ render                   74ms  报告已输出
```

## 快速开始

```bash
pnpm install

# CLI
pnpm analyze ./your-project
pnpm analyze ./your-project --query "找所有处理用户登录的组件"
pnpm analyze ./your-project --json

# Web 看板（两个终端）
pnpm api          # 127.0.0.1:3100
pnpm web:dev      # 127.0.0.1:5173，未启动 API 时展示 Demo 数据

# 回归评估
pnpm eval
```

分析过程只读扫描目标仓库，**不执行目标项目的任何脚本**。产物写入目标仓库的 `.reposurgeon/`（SQLite 索引 + 报告）。

### 可选：启用 LLM 架构解读

不配置也能完整运行，只是没有架构解读那一节。

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://...     # 可选，兼容 DeepSeek 等 OpenAI 协议网关
export REPOSURGEON_MODEL=gpt-4o-mini   # 可选
```

## 工作流

```
START → loadRepository → scanFiles → detectStack → parseSemantic
                                                        │
                        ┌───────────────┬───────────────┼───────────────┐
                        ▼               ▼               ▼               ▼
                 analyzeArchitecture  dependency     quality        frontend     ← 并行 fan-out
                        └───────────────┴───────────────┴───────────────┘
                                                        ▼
                                                 retrieveContext              ← fan-in
                                                        ▼
                                                     narrate                  ← 唯一的 LLM 节点
                                                        ▼
                                                      render → END
```

用 LangGraph 而不是直接串函数，是为了四个独立分析器的**并行 fan-out / fan-in 与状态归并**（`findings` 通道用 concat reducer 汇聚各分析器的产出），以及节点级的进度事件与状态快照。

## 四个设计决策

### 1. 检索单位是符号与依赖闭包，不是文本片段

`src/graph.ts` 用 ts-morph 建立语义图，模块解析直接交给 TypeScript 编译器，因此 tsconfig `paths` alias、`baseUrl`、index 解析、扩展名补全全部由编译器负责。

这不是锦上添花——早期的正则实现只认相对路径，在使用 alias 的仓库上依赖图会大面积残缺，循环依赖检测形同虚设。详见下方对比数据。

### 2. LLM 只负责解释，不负责计算

| 确定性代码 | LLM |
|---|---|
| 依赖图、循环依赖（Tarjan） | 架构分层推断 |
| 复杂度、耦合度、类型占比 | 依赖环的危害解读 |
| **环上最适合切断的边**（按引用次数最少选取） | 技术债优先级排序 |
| 问题聚合与风险分级 | 人类可读的架构叙述 |

循环依赖是图论问题，问模型既慢又不准还不可复现。

### 3. 上下文是压缩过的，且裁剪不静默

符号图直接序列化会轻松几十万 token。`src/narrate.ts` 把它压成分层摘要：目录级聚合、top-N 热点、环及建议切点、按规则聚合的问题统计。

裁剪预算集中在 `LIMITS` 常量，`truncated` 字段**显式记录每个类目被裁掉多少**，prompt 里也要求模型不要把已列出的当成全部。

> 实测：10000 文件、单个环包含全部文件的极端仓库，摘要仍稳定在 ~600 tokens。

### 4. LLM 缺席不影响流水线

未配置模型或调用失败时降级为纯确定性分析，报告里明确写出"未配置模型"，而不是静默少一节。

## 回归评估

把分析器当成一个 CLI 程序来测：不看模型说了什么，只校验固定输入上产出的**事实**。

```bash
$ pnpm eval

✓ PASS  01-relative-cycle         1/1   相对路径循环依赖
✓ PASS  02-alias-cycle            1/1   tsconfig paths alias 循环依赖
✓ PASS  03-dynamic-import-cycle   1/1   动态 import 循环依赖
✓ PASS  04-arrow-component        2/2   箭头函数组件识别
✓ PASS  05-jsx-render-edge        1/1   JSX 渲染关系边
✓ PASS  06-narration-context     10/10  叙述上下文构建与环切点计算

汇总：6 PASS · 0 KNOWN-FAIL · 0 REGRESSION · 0 FIXED
真实通过率：6/6（100%）
```

用例分四种结果：`PASS` / `KNOWN-FAIL`（已知短板，不阻塞）/ `REGRESSION`（退出码 1）/ `FIXED`（提示更新状态）。这样**已知短板不污染红绿信号，也不会被悄悄忘掉**。详见 [fixtures/README.md](fixtures/README.md)。

### 解析器替换前后

02–05 建立时全部是 `known-failure`，根因都是正则解析。改用 ts-morph 后同时转为通过：

| 用例 | 正则实现 | AST 实现 |
|---|---|---|
| `02-alias-cycle` | **0 依赖边，0 个环** | 2 依赖边，1 个环 |
| `03-dynamic-import-cycle` | 1 依赖边，0 个环 | 2 依赖边，1 个环 |
| `04-arrow-component` | 1/2 组件（漏 `Card`） | 2/2 组件 |
| `05-jsx-render-edge` | 无 render 边 | 产出 render 边 |
| **通过率** | **1/5（20%）** | **5/5（100%）** |

## 当前能力

**语义解析**（`src/graph.ts`）
- 走 TypeScript 模块解析：alias、`baseUrl`、index、扩展名补全
- 静态 import、re-export、动态 `import()` 依赖边
- JSX **render 关系边**——`import` 只说明「引用了」，`render` 才说明「渲染了」
- 组件识别覆盖箭头函数组件、`memo`/`forwardRef`/`observer` 包裹、`extends Component` 类组件

**分析器**
- Tarjan 强连通分量循环依赖检测（迭代实现，万级文件长依赖链不爆栈）
- 环上建议切点：环内引用次数最少的边
- 维护性评分：复杂度、耦合度、类型占比（**只统计真实计算出来的维度**）
- React Hooks 疑似条件调用、lint/type 绕过、大文件

**编排与交付**
- LangGraph 工作流，四分析器并行，节点级进度事件（耗时 + 产出摘要）
- 异步 API：`POST /analysis` 返回 202，`GET /analysis/:runId/events` 以 SSE 推送进度
- CLI 实时进度、Markdown / HTML / JSON / Mermaid 报告
- React + Vite 看板：执行时间线、架构解读、Mermaid 架构图、语义检索

## 已知限制

诚实列出，避免误判能力边界：

| 限制 | 说明 |
|---|---|
| **全量解析，无增量** | `scanner.ts` 已计算 `contentHash`，但尚未用于跳过未变更文件 |
| **模块解析无缓存** | 每个 import 都走一次 `ts.resolveModuleName`，未传 `ModuleResolutionCache`，大仓上是主要耗时来源 |
| **ts-morph Project 不释放** | 全量保留 AST，万级文件仓库内存占用需要实测 |
| **单仓 tsconfig** | 只读取仓库根目录的 tsconfig；monorepo 子包各自的 `paths` 尚未逐包解析，此时 alias 会解析失败 |
| **`.vue` 走正则回退** | TypeScript 无法直接解析 SFC，待接入 `@vue/compiler-sfc` |
| **无调用边 / Hook 使用边** | 当前只有 import 与 render 两类关系 |
| **检索未接入 FTS5 与向量** | SQLite 建了 `files_fts` 表但主流程用的是关键词匹配；中文长尾表达依赖 LLM 查询计划 |
| **checkpoint 不支持恢复** | 状态快照写入了 SQLite，但没有基于它的 resume 逻辑；LangGraph 侧用的是进程内 `MemorySaver` |
| **架构分层按顶层目录名推断** | 尚未基于依赖方向与模块语义判定 |
| **`runs` SQLite 表只增不删** | 每次分析插入一份完整报告 JSON，`.reposurgeon/index.db` 会随运行次数膨胀 |
| **前端构建产物需要 API 地址配置** | 相对路径 `/analysis` 依赖 vite dev proxy，静态托管 `web/dist` 时无法访问 API |
| **LangGraph 的 MaxListeners 警告** | 节点数超过 Node 默认的 10 个 abort listener 上限，会打印一条无害警告 |

## 路线图

1. 增量索引：用 `contentHash` 跳过未变更文件，把大仓重复分析的成本降下来
2. 大仓性能基线：在万级文件真实仓库上测出解析耗时曲线
3. 关系边扩展：函数调用边、Hook 使用边、Store 使用边
4. `.vue` 接入 `@vue/compiler-sfc`
5. 从「分析」走向「改造」：LLM 输出结构化改造指令，由 ts-morph 确定性落地，用 tsc / 测试做验证闭环

## 目录结构

```
src/
├── workflow.ts      LangGraph 编排、State 通道、节点级进度事件
├── scanner.ts       文件扫描、hash、行数、圈复杂度
├── stack.ts         技术栈识别
├── graph.ts         ts-morph 语义解析：符号、依赖边、render 边
├── analyzers.ts     Tarjan 循环依赖、前端专项检查、维护性指标
├── architecture.ts  目录聚合、分层推断、组件拓扑
├── narrate.ts       上下文压缩、环切点计算、LLM 架构解读
├── retrieval.ts     查询计划与混合检索
├── report.ts        Markdown / HTML / JSON 报告
├── storage.ts       SQLite 索引与状态快照
├── llm.ts           模型解析与结构化输出
├── api.ts           异步任务 API + SSE 进度流
└── cli.ts           命令行入口

fixtures/            回归评估用例
scripts/eval.ts      评估执行器
web/                 React + Vite 分析看板
```
