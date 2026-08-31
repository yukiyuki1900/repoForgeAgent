<div align="center">

# RepoForgeAgent

**面向前端仓库的代码分析与改造 Agent。**

事实由确定性代码算出，LLM 只负责解释——以及在只读工具集里自己决定查什么。

<sub>TypeScript · LangGraph · ts-morph · Vercel AI SDK · MCP · React</sub>

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

三种模式都有命令行与 Web 看板两套入口。同一套工具还可以通过 [MCP](#mcp-server) 挂给 Claude Code / Cursor，配套的 [Skill](#skill) 说明该怎么用。

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

# MCP Server：把工具集交给 Claude Code / Cursor
pnpm mcp ./your-project
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

## 分析

```
$ pnpm analyze ./your-project

  ✓ loadRepository
  ✓ scanFiles
  ✓ detectStack            Vue + Vite
  ✓ plan                   意图：全量审计
  ✓ parseSemantic
  ✓ quality
  ✓ frontend
  ✓ analyzeArchitecture
  ✓ dependency
  ✓ narrate                架构解读已生成
  ✓ render                 报告已输出
```

每个节点会实时汇报自己的产出（文件数、符号数、关系边、循环依赖处数等）。

带上 `--query` 时，`plan` 节点会识别意图并裁掉与答案无关的节点：

```
$ pnpm analyze ./your-project --query "有循环依赖吗"

  ✓ plan   意图：依赖与循环 · 跳过 analyzeArchitecture、frontend、narrate
```

| 意图 | analyzeArchitecture | frontend | narrate |
|---|:---:|:---:|:---:|
| 全量审计（默认） | ✓ | ✓ | ✓ |
| 依赖与循环 | — | — | — |
| 架构与分层 | ✓ | — | ✓ |
| 质量与技术债 | — | ✓ | — |
| 语义检索 | — | — | — |

`dependency` 与 `quality` 恒在——它们的产出是报告的必填内容。被跳过的节点会连同理由写进报告的「执行计划」一节；想跑满加 `--full`。

## 追问

模型拿到 8 个只读工具，自己决定查什么、查几轮：

```
$ pnpm ask ./your-project "哪个模块被依赖得最多，它做了哪些事"

  ✓ 索引已建立

  → listHotspots      按入边排序，最高 src/utils/index.ts
  → getFileSummary    src/utils/index.ts · 入边远高于出边
  → getDependents     src/utils/index.ts ← 依赖方覆盖各业务页面
  → readSource        src/utils/index.ts:1-20
```

| 工具 | 用途 |
|---|---|
| `searchFiles` | 按路径关键词定位文件 |
| `getFileSummary` | 行数、复杂度、导出符号、入边出边数 |
| `getDependents` / `getDependencies` | 谁 import 了它 / 它 import 了谁 |
| `findSymbol` | 按名字查符号定义位置 |
| `listHotspots` | 按被依赖次数排名 |
| `listCycles` | 循环依赖，可按文件过滤 |
| `readSource` | 读源码片段，单次上限 120 行 |

工具调用与回答都是流式的，每条调用都标明查的是哪个文件——回答里的每个断言都能据此核对。轮次上限默认 8（`--max-steps` 可调），撞上限时会如实标注并交出已查到的线索。

## MCP Server

同一套工具可以挂给 Claude Code / Cursor，在编辑器里直接问「这个仓库有哪些循环依赖」：

```jsonc
// Claude Code: ~/.claude/settings.json 的 mcpServers
// Cursor: .cursor/mcp.json
{
  "mcpServers": {
    "repoforge": {
      "command": "npx",
      "args": ["tsx", "/path/to/RepoForgeAgent/src/mcp.ts", "/path/to/your-project"]
    }
  }
}
```

暴露上面那 8 个只读工具，外加一个 `refreshIndex`（改完代码后重建索引），全部标注 `readOnlyHint: true`。

改造能力**没有**接入 MCP——写盘操作不该藏在一个标着只读的协议出口后面。

## Skill

MCP 给的是**能力**，Skill 给的是**流程**。挂上 MCP 之后模型拿到 8 个工具，但先查什么、查到之后怎么判断，仍然没人告诉它。

[.agents/skills/frontend-repo-checkup](.agents/skills/frontend-repo-checkup/SKILL.md) 把「一个有经验的人会怎么用这套工具」写成了操作手册：先建立全局事实、再定位热点、检查分层是否倒置、判断循环依赖能否自动修、最后产出带行号的行动清单。里面同时写了判断标准与反模式——比如「行数很少但入边极高 = 桶文件」，比如不要产出「建议解耦」这种没有落点的结论。

### 跨客户端

[Agent Skills](https://agentskills.io) 是开放标准，Claude Code、Cursor、VS Code、Codex 都能加载。规范定义的是 skill 目录的结构，**发现路径由各客户端自己定**，所以真身放在中立目录，客户端入口用相对符号链接指过去：

```
.agents/skills/frontend-repo-checkup/SKILL.md   ← 真身
.claude/skills/frontend-repo-checkup  ─┐
.cursor/skills/frontend-repo-checkup  ─┴─► 符号链接
```

一份内容，改一处两边同时生效。想在**任意项目**里用（而不只是在本仓库里），链到用户级目录：

```bash
ln -s "$PWD/.agents/skills/frontend-repo-checkup" ~/.claude/skills/
ln -s "$PWD/.agents/skills/frontend-repo-checkup" ~/.cursor/skills/
```

`tests/skill.test.ts` 会验证链接没断、三个路径同源、手册里引用的工具与命令真实存在——手册不会被编译，写错一个工具名只有等模型照着做失败了才知道。

### 三个出口

```
tools.ts  ──►  ask        自己的 agent loop
          ──►  mcp.ts     别人的编辑器，标准协议
          ──►  SKILL.md   怎么用才对，标准格式
```

## 改造

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

只做 `import type` 这一种变换——它是语义等价的机械变换，判定靠 TypeScript 的引用分析，效果可以用「重跑 Tarjan」直接验证。判定从严：只要有一处引用落在值位置就不改。

写入后有两道验证：

- **类型** — 改动前后各做一次全量 pre-emit 检查，判据是**不新增**错误
- **结构** — 重扫仓库、重跑 Tarjan，实测环数必须与预测完全一致

任一不符就 `git checkout --` 回滚，diff 仍留档供人工复盘。写入前要求目标文件已被 git 跟踪且无未提交改动。

## 技术栈

| 依赖 | 用途 |
|---|---|
| **ts-morph / TypeScript Compiler API** | 建立符号与依赖图；模块解析交给编译器，tsconfig `paths`、`baseUrl`、index 解析全部免费获得 |
| **LangGraph** | 分析流水线编排：并行 fan-out / fan-in、状态归并、条件路由、节点级进度事件 |
| **Vercel AI SDK** | `generateObject` 拿结构化输出，`streamText` + `tools` 跑工具调用循环 |
| **MCP SDK** | 把工具集通过标准协议交给 Claude Code / Cursor |
| **@vue/compiler-sfc** | 可选依赖，`.vue` 抽出 script 走同一条 AST 路径 |
| **better-sqlite3** | 可选依赖，供看板加载命令行跑出的历史结果 |
| **React + Vite** | Web 看板 |

每项选型的理由与代价见 [docs/DESIGN.md](docs/DESIGN.md)。

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
                                  ↑   ↓                双层验证 + 回滚
                                  │  模型自主循环
                                  │
                            mcp.ts ──► Claude Code / Cursor
                          同一套工具，标准协议出口
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

## 开发

```bash
pnpm eval          # 回归评估：校验分析器在固定输入上产出的事实
pnpm test          # 端到端：图真的能跑通、改动真的写盘、MCP 真的能握手
pnpm build         # 类型检查与编译
pnpm format        # 代码格式化
pnpm stop          # 终止残留的开发进程
```

评估分两层：`pnpm eval` 校验**判断准不准**（fixture 驱动，含专门保护误报率的用例）；`pnpm test` 校验**动作对不对**（建真实 git 仓库写盘、桩模型跑 tool-calling 循环、真实 MCP 客户端握手、前后端字段契约）。

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
├── mcp.ts           MCP Server：同一套工具的标准协议出口
├── refactor.ts      import type 拆环的检测与模拟
├── apply.ts         写入、两层验证、失败回滚与产物留档
├── tasks.ts         三种模式共用的任务状态机与 SSE
├── jobs.ts          三种模式各自的任务体
├── api.ts           HTTP 路由、目录浏览与历史记录
└── cli.ts           命令行入口

web/                 React + Vite 看板
fixtures/            回归评估用例
tests/               端到端与契约测试
.claude/skills/      前端仓库体检的操作手册
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | **设计取舍**：为什么这么做，以及不这么做的代价 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 能力边界与路线图 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 依赖图缺边、改动不生效、端口占用 |
| [fixtures/README.md](fixtures/README.md) | 用例结构与五种结果语义 |
