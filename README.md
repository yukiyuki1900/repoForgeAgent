# 🔍 RepoForgeAgent

面向前端仓库的代码分析 Agent。用 AST 建立语义图，用 LangGraph 编排分析流水线，LLM 只负责解读——**事实由确定性代码算出**。

以下是一个 319 文件真实 Vue 仓库上的实测输出：

```
$ pnpm analyze ./your-project

  ✓ loadRepository           11ms
  ✓ scanFiles                90ms  319 个文件
  ✓ detectStack               2ms  Vue + Vite
  ✓ plan                      0ms  意图：全量审计 · 跳过 retrieveContext
  ✓ parseSemantic          4737ms  2694 个符号 · 936 条关系边
  ✓ quality                   6ms  维护性评分 56
  ✓ frontend                  7ms  18 个前端问题
  ✓ analyzeArchitecture      11ms  14 个模块
  ✓ dependency               11ms  1 处循环依赖
  ✓ narrate               18156ms  架构解读已生成
  ✓ render                   23ms  报告已输出
```

## 核心能力

- **执行计划** — 先识别意图再决定跑哪些节点，条件 fan-out 动态裁剪分支；每一次裁剪都带理由并写进报告
- **语义解析** — ts-morph 建立符号与依赖图，模块解析交给 TypeScript 编译器；自动读取 tsconfig `paths` 与 vite / webpack / rspack / nuxt 的 `resolve.alias`
- **Vue / React 双栈** — Vue SFC 经 `@vue/compiler-sfc` 抽出 script 走同一条 AST 路径；render 关系边分别取自 JSX 与 template
- **依赖分析** — Tarjan 循环依赖检测、环上最优切点（按引用次数最少选取）、模块级依赖图；`import type` 记为类型边，不计入运行时环
- **改造闭环** — 识别环上仅用于类型的导入，改成 `import type` 并写回仓库；改动前后各做一次全量类型检查（判据是不新增错误），再重扫仓库重跑 Tarjan 与预测对账，任一不符自动 `git checkout` 回滚
- **前端专项** — Hooks 疑似条件调用、lint / type 绕过、大文件、维护性评分
- **架构逆向** — 剥离公共前缀后聚合模块、分层推断、Mermaid 架构图
- **语义检索** — 自然语言查询，结构化召回 + 关键词匹配，中文概念映射到代码标识符
- **LLM 解读** — 架构叙述与技术债优先级排序；未配置模型时自动降级为纯确定性分析
- **多种交付** — CLI 实时进度、异步 API + SSE 进度流、React 看板、Markdown / HTML / JSON 报告

## 快速开始

```bash
pnpm install
```

| 命令 | 说明 |
|---|---|
| `pnpm analyze ./your-project` | 全量审计 |
| `pnpm analyze ./your-project --query "有循环依赖吗"` | 定向提问，只跑与答案相关的节点 |
| `pnpm analyze ./your-project --full` | 忽略意图裁剪，跑满全部节点 |
| `pnpm analyze ./your-project --json` | 机器可读输出 |
| `pnpm refactor ./your-project` | 改造计划，只读 |
| `pnpm refactor ./your-project --apply` | 写入 + 验证 + 失败回滚 |
| `pnpm dev` | Web 看板（API + 前端） |
| `pnpm stop` | 终止残留进程 |

分析过程**只读扫描目标仓库，不执行目标项目的任何脚本**。产物写入目标仓库的 `.reposurgeon/`：

```
<your-project>/.reposurgeon/
├── reports/              report.html / report.md / report.json
├── refactors/<时间戳>/    refactor.diff · verify-report.md
└── index.db              SQLite 索引（可选，供看板加载历史结果）
```

CLI 与看板是独立进程，通过这个 SQLite 索引打通——看板里填入同一路径即可加载命令行跑出的结果。索引依赖原生模块 `better-sqlite3`，不可用时会告警并跳过，报告照常输出。

## 执行计划

同一个仓库，问法不同，跑的节点就不同：

```
$ pnpm analyze ./your-project --query "有循环依赖吗"

  ✓ plan   0ms  意图：依赖与循环 · 跳过 analyzeArchitecture、frontend、narrate
```

为什么值得这么做——看上面那次全量运行的耗时分解：

| 节点 | 耗时 | 占比 |
|---|---|---|
| `narrate` | 18156ms | **79%** |
| `parseSemantic` | 4737ms | 21% |
| 其余 8 个节点合计 | ~160ms | <1% |

只想知道「有没有循环依赖」时，等 23 秒里有 18 秒花在生成一段没人要的架构叙述上。裁掉之后约 **4.9 秒**（按上表分解推算），token 消耗归零。

裁剪规则写在 [plan.ts](src/plan.ts)：

| 意图 | analyzeArchitecture | frontend | narrate |
|---|:---:|:---:|:---:|
| 全量审计（默认） | ✓ | ✓ | ✓ |
| 依赖与循环 | — | — | — |
| 架构与分层 | ✓ | — | ✓ |
| 质量与技术债 | — | ✓ | — |
| 语义检索 | — | — | — |

几条刻意的取舍：

- **`dependency` 与 `quality` 恒在** —— 报告的 `metrics` 与循环依赖是必填内容，跳过它们等于产出一份残缺却看不出残缺的报告；何况两者合计 17ms，省下来没有意义
- **不为了「像 Agent」而路由** —— 四个确定性分析器加起来 35ms，路由它们是自欺欺人。真正值得决策的只有 LLM 节点
- **决策用规则不用模型** —— 意图分类是低维、可枚举、要求可复现的判断，交给 LLM 只换来延迟、不确定性和「幻觉出不存在的节点名」的风险。`createAnalysisGraph({ planner })` 留了注入点，架构上并不锁死
- **裁剪必须留痕** —— 每个被跳过的节点都带理由，写进 CLI 输出和报告的「执行计划」一节。否则读报告的人会把「本次没跑」误解成「跑了但没发现问题」

## 改造闭环

只做**能被编译器证伪**的变换。`import type` 是语义等价的机械变换：判定靠 TypeScript 的引用分析，改造是一次 AST 调用，效果可以用「重跑 Tarjan」直接验证——全程不需要模型生成任何代码。

```
$ pnpm refactor ./your-project --apply

  ✓ 扫描 2 个文件
  ✓ 检测到 1 处循环依赖

  · 前置检查通过：2 个目标文件均已被 git 跟踪且无未提交改动
  · 类型基线：0 条已有错误
  · 类型检查：0 条错误，新增 0 条（3554ms）
  · 已写入 2 个文件
  · 重新扫描仓库，验证环是否真的消失…
  · 循环依赖：1 → 0（预测 0）

✓ 改造已应用
  类型检查 基线 0 条错误 → 改后 0 条，新增 0 条
  环验证   1 → 0（预测 0，一致）
```

两道关卡缺一不可：

- **类型**：改动前后各做一次全量 pre-emit 检查，判据是**不新增**错误。真实仓库的 `tsc` 极少是干净的，要求零错误等于永不执行
- **结构**：写入后重扫仓库、重建依赖图、重跑 Tarjan，实测环数必须与 dry-run 的预测完全一致。「能编译」不等于「环真的断了」

任一不符就 `git checkout --` 回滚，diff 仍会留档供人工复盘。写入前要求目标文件已被 git 跟踪且无未提交改动——没有可靠回滚手段就不动用户的代码。

## 工作流

```
START → loadRepository → scanFiles → detectStack → plan     ← 决策点
                                                     │
                                                     ▼
                                              parseSemantic
                                                     │
                       ┌─────────────┬───────────────┼───────────────┐
                       ▼             ▼               ▼               ▼
              analyzeArchitecture  dependency     quality        frontend   ← 条件 fan-out
                  （可裁剪）        （恒在）       （恒在）        （可裁剪）
                       └─────────────┴───────────────┴───────────────┘
                                                     ▼
                                          retrieveContext              ← 有问题才进
                                                     ▼
                                                  narrate              ← 唯一的 LLM 节点，可裁剪
                                                     ▼
                                                  render → END
```

## 配置

全部可选，不配置也能完整运行——只是没有架构解读与 LLM 查询计划。

```bash
cp .env.example .env
```

复制后用编辑器填入 key 即可，不必每次 `export`。**不要把 key 写在命令行里**——zsh 交互模式默认不把 `#` 当注释，追加说明会被当成参数；而且命令行会进入 shell 历史。

| 环境变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | 启用 LLM 架构解读与查询计划 |
| `OPENAI_BASE_URL` | OpenAI 协议兼容网关（DeepSeek、智谱等） |
| `REPOSURGEON_MODEL` | 默认 `gpt-4o-mini` |
| `REPOSURGEON_API_PORT` | API 端口，默认 `3100` |
| `REPOSURGEON_WEB_PORT` | 看板端口，默认 `5173` |

`.env.local` 会覆盖 `.env`；显式 `export` 的环境变量优先级最高。

单次全量分析约消耗 2000 输入 + 1400 输出 token，用国内兼容网关跑百次量级的成本在个位数元。定向提问会跳过 `narrate`，token 消耗为零。

未配置模型时 `plan` 会直接不走 `narrate` 这条边，而不是进入节点后再降级。

`@vue/compiler-sfc` 是可选依赖，仅在仓库存在 `.vue` 文件时需要。

## 目录结构

```
src/
├── workflow.ts      LangGraph 编排、State 通道、条件路由、节点级进度事件
├── plan.ts          意图识别与节点裁剪规则
├── scanner.ts       文件扫描、hash、行数、圈复杂度
├── stack.ts         技术栈识别
├── graph.ts         ts-morph 语义解析：符号、依赖边、render 边
├── alias.ts         构建配置里的 resolve.alias 静态提取
├── analyzers.ts     Tarjan 循环依赖、前端专项检查、维护性指标
├── architecture.ts  模块聚合、分层推断、组件拓扑
├── narrate.ts       上下文压缩、环切点计算、LLM 架构解读
├── retrieval.ts     查询计划与混合检索
├── locate.ts        按目录特征反查绝对路径
├── refactor.ts      import type 拆环的检测与模拟
├── apply.ts         写入、两层验证、失败回滚与产物留档
├── report.ts        Markdown / HTML / JSON 报告
├── storage.ts       SQLite 索引与状态快照（原生模块不可用时自动降级）
├── llm.ts           模型解析与结构化输出
├── env.ts           .env 加载
├── api.ts           异步任务 API + SSE 进度流
└── cli.ts           命令行入口

web/                 React + Vite 分析看板
fixtures/            回归评估用例
tests/               端到端用例：条件路由与改造闭环（会真实写盘）
scripts/             评估执行器与本地启动脚本
```

## 开发

```bash
pnpm eval          # 回归评估：校验分析器在固定输入上产出的事实
pnpm test          # 端到端：图真的能跑通、改动真的写盘、验证真的会拦
pnpm build         # 类型检查与编译
pnpm format        # 代码格式化
```

## 文档

- [设计决策](docs/DESIGN.md) — 为什么这么做，以及不这么做的代价
- [已知限制](docs/LIMITATIONS.md) — 能力边界与路线图
- [故障排查](docs/TROUBLESHOOTING.md) — 依赖图缺边、改动不生效、端口占用
- [回归评估](fixtures/README.md) — 用例结构与四种结果语义
