<div align="center">

# RepoForgeAgent

**面向前端仓库的代码分析与改造 Agent。**

事实由确定性代码算出，LLM 只负责解释——以及在只读工具集里自己决定查什么。

<sub>TypeScript · LangGraph · ts-morph · Vercel AI SDK · React</sub>

</div>

---

## 为什么做这个

在一个陌生的前端仓库里，三个问题最常见，也最难靠通读代码回答：

1. **这个仓库的结构是什么样的？** 目录名会骗人，`utils` 里可能塞着业务逻辑。
2. **改这个文件会影响到谁？** 靠全局搜索找引用，会漏掉 alias 导入和动态 `import()`。
3. **这些循环依赖能修吗？** 知道有环容易，判断哪一条边能安全断开很难。

市面上的 AI 代码工具大多把整个仓库塞进模型上下文，让它「看着办」。这条路在几百个文件的仓库上就会失真：模型会编造不存在的文件、把目录名当成职责、给出无法验证的建议。

这个项目走另一条路——**能算出来的绝不问模型**：

- 依赖图用 TypeScript 编译器解析，循环依赖用 Tarjan 算，影响面靠数入边
- 模型只做两件确定性代码做不了的事：把事实翻译成人话，以及在一组只读工具里自主查证
- 每一次改造都必须能被编译器证伪，验证不过就自动回滚

## 三种模式

| 模式 | 做什么 | 谁做决策 | 风险 |
|---|---|---|---|
| **分析** `analyze` | 全量审计：依赖图、循环依赖、架构逆向、维护性评分 | 确定性代码 + LLM 解读 | 只读 |
| **追问** `ask` | 把语义图开放成 8 个只读工具，模型自己查证后回答 | 模型自主 | 只读 |
| **改造** `refactor` | 用 `import type` 打破循环依赖，写入并验证 | 确定性代码 | **写盘** |

三种模式都有命令行与 Web 看板两套入口。

## 快速开始

```bash
pnpm install
```

```bash
# 分析：全量审计
pnpm analyze ./your-project

# 分析：带问题，只跑与答案相关的节点
pnpm analyze ./your-project --query "有循环依赖吗"

# 追问：模型自主调用工具查证
pnpm ask ./your-project "哪个模块被依赖得最多，它做了哪些事"

# 改造：先看计划
pnpm refactor ./your-project

# 改造：写入 + 验证 + 失败自动回滚
pnpm refactor ./your-project --apply

# Web 看板（三种模式都有界面）
pnpm dev
```

分析过程**只读扫描目标仓库，不执行目标项目的任何脚本**。产物写入 `<your-project>/.reposurgeon/`：

```
.reposurgeon/
├── reports/              report.html · report.md · report.json
├── refactors/<时间戳>/    refactor.diff · verify-report.md
└── index.db              SQLite 索引（可选，供看板加载历史结果）
```

## 配置

LLM 相关能力需要配置模型，其余功能不配也能完整运行——只是没有架构解读，`ask` 不可用。

```bash
cp .env.example .env      # 用编辑器填入 key
```

| 环境变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | 启用架构解读、查询计划与 `ask`（后者强制需要） |
| `OPENAI_BASE_URL` | OpenAI 协议兼容网关（DeepSeek、智谱等） |
| `REPOSURGEON_MODEL` | 默认 `gpt-4o-mini` |
| `REPOSURGEON_API_PORT` | API 端口，默认 `3100` |
| `REPOSURGEON_WEB_PORT` | 看板端口，默认 `5173` |

`.env.local` 覆盖 `.env`；显式 `export` 的优先级最高。**不要把 key 写在命令行里**——zsh 交互模式默认不把 `#` 当注释，追加说明会被当成参数，而且命令行会进 shell 历史。

## 技术选型与理由

**TypeScript Compiler API（经 ts-morph）** — 模块解析直接交给编译器，因此 tsconfig `paths`、`baseUrl`、index 解析、扩展名补全全部免费获得。早期用正则实现时，一个使用 alias 的仓库依赖图会大面积残缺——两个文件明明互相 import，却一条边都扫不出来，循环依赖检测形同虚设。

**Tarjan 强连通分量** — 循环依赖是图论问题，问模型既慢又不准还不可复现。递归实现在万级文件的长依赖链上会爆栈，所以用了显式栈的迭代版。

**LangGraph** — 用它只为两件事：四个分析器的并行 fan-out / fan-in 与状态归并，以及节点级的进度事件。加上 `plan` 节点后又多了一条：条件路由动态裁剪分支。

**Vercel AI SDK** — `generateObject` 拿结构化输出（架构解读、查询计划），`streamText` + `tools` 跑 `ask` 的工具调用循环。换模型只改环境变量。

**@vue/compiler-sfc（可选依赖）** — `.vue` 抽出 script 块走同一条 AST 路径。做成可选：只分析 React 项目的人不该被 Vue 编译器卡住。

**better-sqlite3（可选）** — 让 Web 看板能加载命令行跑出的历史结果。原生模块不可用时告警并跳过，报告照常输出——它是加速层，不是主产物。

## 架构

```
                    ┌──────────── 命令行 ────────────┐
                    │  analyze · ask · refactor      │
                    └───────────────┬────────────────┘
                                    │
  scanner ──► graph ──► ┌───────────┴───────────┐
  文件扫描    AST 语义图  │  workflow（LangGraph） │  ◄── Web 看板
                        │  tasks（SSE 进度流）    │      React + Vite
                        └───────────┬───────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        analyzers             tools + ask            refactor + apply
     Tarjan / 指标 / 前端      8 个只读工具            import type 拆环
                              模型自主循环            双层验证 + 回滚
```

分析流水线的节点编排：

```
START → loadRepository → scanFiles → detectStack → plan     ← 决策点
                                                     │
                                              parseSemantic
                                                     │
                       ┌─────────────┬───────────────┼───────────────┐
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

## 执行计划：先量再决定路由什么

给流水线加决策节点最容易滑向表演——每个节点前挂个 `if`，看起来很 Agent，实际一秒没省。所以先量成本分布，再决定路由什么：**LLM 节点是压倒性的耗时大头，AST 解析次之，四个确定性分析器的开销可以忽略。**

结论很直白：路由那几个分析器是自欺欺人，真正值得决策的只有 LLM 节点。

```
$ pnpm analyze ./your-project --query "有循环依赖吗"

  ✓ plan   意图：依赖与循环 · 跳过 analyzeArchitecture、frontend、narrate
```

只想知道「有没有循环依赖」时，架构叙述既不是答案的一部分，又恰好是最贵的一步。裁剪规则见 [plan.ts](src/plan.ts)：

| 意图 | analyzeArchitecture | frontend | narrate |
|---|:---:|:---:|:---:|
| 全量审计（默认） | ✓ | ✓ | ✓ |
| 依赖与循环 | — | — | — |
| 架构与分层 | ✓ | — | ✓ |
| 质量与技术债 | — | ✓ | — |
| 语义检索 | — | — | — |

`dependency` 与 `quality` 恒在：它们的产出是报告必填内容，跳过等于产出一份残缺却看不出残缺的报告。裁剪必须留痕——每个被跳过的节点都带理由写进报告，否则读的人会把「本次没跑」误解成「跑了但没发现问题」。

## 追问：模型编排自己

项目其余部分是**我们编排模型**，`ask` 相反：

```
$ pnpm ask ./your-project "哪个模块被依赖得最多，它做了哪些事"

  ✓ 索引已建立

  → listHotspots      按入边排序，最高 src/utils/index.ts
  → getFileSummary    src/utils/index.ts · 入边远高于出边
  → getDependents     src/utils/index.ts ← 依赖方覆盖各业务页面
  → readSource        src/utils/index.ts:1-20
```

每条调用都带上了**查的是哪个文件**——三次 `getDependents` 如果只显示数量，读的人无法核对模型说的是哪一个。工具调用与回答都是流式的，界面上不折叠、不隐藏——**一个看不到推理路径的 Agent 回答，和一段编出来的话没有区别。**

| 工具 | 用途 |
|---|---|
| `searchFiles` | 按路径关键词定位文件 |
| `getFileSummary` | 行数、复杂度、导出符号、入边出边数 |
| `getDependents` / `getDependencies` | 谁 import 了它 / 它 import 了谁 |
| `findSymbol` | 按名字查符号定义位置 |
| `listHotspots` | 按被依赖次数排名 |
| `listCycles` | 循环依赖，可按文件过滤 |
| `readSource` | 读源码片段，单次上限 120 行 |

四条工具设计上的取舍：

- **只暴露索引，不暴露文件系统** — 路径不在索引里就查不到。天然挡掉路径穿越，不需要写 `..` 校验，因为根本没有一条通往 fs 的路
- **查不到时给候选** — 模型常写出 `utils/request.ts` 这类差不多但不对的路径。返回 not found 它只会换个名字继续猜
- **截断必须写进返回值** — 静默截断会让模型把「前 40 条」当成全部，然后给出一个自信的错误结论
- **越界夹紧而非报错** — 模型对行数的估计经常偏大，报错是在惩罚一个无害的猜测

## 改造：只做能被编译器证伪的变换

```
$ pnpm refactor ./your-project --apply

  · 前置检查通过：目标文件均已被 git 跟踪且无未提交改动
  · 类型基线：记录已有错误
  · 类型检查：新增 0 条错误
  · 已写入目标文件
  · 重新扫描仓库，验证环是否真的消失…
  · 循环依赖：实测与预测一致

✓ 改造已应用
```

循环依赖的一般性修复（提取共享模块、依赖倒置）是架构决策，只能靠模型生成代码，既有幻觉风险也无法证明行为不变。而 `import type` 是**语义等价的机械变换**：判定靠 TypeScript 的引用分析，改造是一次 AST 调用，效果可以用「重跑 Tarjan」直接验证。

两道关卡缺一不可：

- **类型** — 改动前后各做一次全量 pre-emit 检查，判据是**不新增**错误。真实仓库的 `tsc` 极少干净，要求零错误等于永不执行
- **结构** — 写入后重扫仓库、重跑 Tarjan，实测环数必须与预测完全一致。「能编译」不等于「环真的断了」

任一不符就 `git checkout --` 回滚，diff 仍留档供人工复盘。

### 为什么 `ask` 敢交出控制权，`--apply` 不敢

判据不是任务难不难，而是**这一步做错了，代价是什么**：

| | `ask` | `refactor --apply` |
|---|---|---|
| 谁做决策 | 模型自主 | 确定性代码 |
| 最坏情况 | 查了一堆无关的东西 | 改坏能跑的代码 |
| 如何兜底 | 只读 + 轮次上限 + 答案带行号可核对 | 类型检查 + 环数对账 + git 回滚 |

## 开发

```bash
pnpm eval          # 回归评估：校验分析器在固定输入上产出的事实
pnpm test          # 端到端：图真的能跑通、改动真的写盘、验证真的会拦
pnpm build         # 类型检查与编译
pnpm format        # 代码格式化
pnpm stop          # 终止残留的开发进程
```

评估分两层，混在一起就什么都测不了：`pnpm eval` 校验**判断准不准**（含专门保护误报率的用例）；`pnpm test` 校验**动作对不对**（建真实 git 仓库写盘、桩模型跑 tool-calling 循环、前后端字段契约）。

```
src/
├── workflow.ts      LangGraph 编排、State 通道、条件路由
├── plan.ts          意图识别与节点裁剪规则
├── scanner.ts       文件扫描、hash、行数、圈复杂度
├── graph.ts         ts-morph 语义解析：符号、依赖边、render 边
├── alias.ts         构建配置里的 resolve.alias 静态提取
├── analyzers.ts     Tarjan 循环依赖、前端专项检查、维护性指标
├── architecture.ts  模块聚合、分层推断、组件拓扑
├── narrate.ts       上下文压缩、环切点计算、LLM 架构解读
├── retrieval.ts     查询计划与混合检索
├── tools.ts         暴露给模型的只读工具集
├── ask.ts           tool-calling 循环、流式输出、轮次控制
├── refactor.ts      import type 拆环的检测与模拟
├── apply.ts         写入、两层验证、失败回滚与产物留档
├── tasks.ts         三种模式共用的任务状态机与 SSE
├── jobs.ts          三种模式各自的任务体
├── api.ts           HTTP 路由、目录浏览与历史记录
└── cli.ts           命令行入口

web/                 React + Vite 看板
fixtures/            回归评估用例
tests/               端到端与契约测试
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 设计取舍，以及不这么做的代价 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 能力边界与路线图 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 依赖图缺边、改动不生效、端口占用 |
| [fixtures/README.md](fixtures/README.md) | 用例结构与五种结果语义 |
