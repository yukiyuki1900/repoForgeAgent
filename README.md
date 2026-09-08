<div align="center">

# RepoForgeAgent

**面向前端仓库的代码分析与改造 Agent。**

事实由确定性代码算出，LLM 只负责解释——以及在只读工具集里自己决定查什么。

<sub>TypeScript · LangGraph · ts-morph · Vercel AI SDK · MCP · React</sub>

</div>

---

## 它解决什么问题

在一个陌生的前端仓库里，三个问题最常见，也最难靠通读代码回答：

1. **这个仓库的结构是什么样的？** 目录名会骗人，`utils` 里可能塞着业务逻辑。
2. **改这个文件会影响到谁？** 靠全局搜索找引用，会漏掉 alias 导入和动态 `import()`。
3. **这些循环依赖能修吗？** 知道有环容易，判断哪一条边能安全断开很难。

这个项目的做法是**能算出来的绝不问模型**：依赖图用 TypeScript 编译器解析，循环依赖用 Tarjan 算，影响面靠数入边；模型只做两件确定性代码做不了的事——把事实翻译成人话，以及在一组只读工具里自主查证。每一次改造都必须能被编译器证伪，验证不过就自动回滚。

设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

## 三种模式

| 模式 | 做什么 | 谁做决策 | 风险 |
|---|---|---|---|
| **分析** `analyze` | 全量审计：依赖图、循环依赖、架构逆向、维护性评分 | 确定性代码 + LLM 解读 | 只读 |
| **追问** `ask` | 把语义图开放成 9 个只读工具，模型自己查证后回答 | 模型自主 | 只读 |
| **改造** `refactor` | 三条链路：`import type` 破环、清理未使用的导出、模型提方案 | 前两条确定性代码，第三条模型 | **写盘** |

三种模式都有命令行与 [Web 看板](#web-看板)两套入口。同一套工具还可以通过 [MCP](#mcp-server) 挂给 Claude Code / Cursor，配套的 [Skill](#skill) 说明该怎么用。

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

# 改造：清理没人用的导出
pnpm refactor ./your-project --dead-exports

# 改造：让模型对「规则主动放弃的那部分」提方案（只列出，不执行）
pnpm refactor ./your-project --propose

# 人挑一条，执行这一条。没有「全部执行」
pnpm refactor ./your-project --propose --execute 1

# Web 看板（三种模式都有界面，任务离线执行、可分享可回看）
pnpm dev

# MCP Server：把工具集交给 Claude Code / Cursor
pnpm mcp ./your-project
```

分析过程**只读扫描目标仓库，不执行目标项目的任何脚本**。产物写入 `<your-project>/.reposurgeon/`：

```
.reposurgeon/
├── reports/              report.html · report.md · report.json
├── refactors/<时间戳>/    refactor.diff · verify-report.md
└── index.db              SQLite（可选）：分析结果索引 + 任务历史归档
```

归档**跟着被分析的仓库走**，不在一个全局库里：仓库删了历史跟着没，换台机器打开同一个仓库历史还在。

## 配置

LLM 相关能力需要配置模型，其余功能不配也能完整运行——只是没有架构解读，`ask` 不可用。

```bash
cp .env.example .env      # 用编辑器填入 key
```

| 环境变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | 启用架构解读、查询计划与 `ask`（后者强制需要） |
| `OPENAI_BASE_URL` | OpenAI 协议兼容网关（DeepSeek、智谱等） |
| `REPOSURGEON_MODEL` | 官方端点下默认 `gpt-4o-mini`；**配了网关就必须一起配它** |
| `REPOSURGEON_API_PORT` | API 端口，默认 `3100` |
| `REPOSURGEON_WEB_PORT` | 看板端口，默认 `5173` |

后两项是**一对**：默认模型名只在 OpenAI 官方端点上存在，只配 `OPENAI_BASE_URL` 会拿着 `gpt-4o-mini` 去请求别家网关，换回一句「模型不存在」——所以这种半截配置会在启动路径上直接判为配置错误，而不是留到发请求时才炸。

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
  ✓ deadExports
  ✓ analyzeArchitecture
  ✓ dependency
  ✓ narrate                架构解读已生成
  ✓ render                 报告已输出
```

每个节点会实时汇报自己的产出（文件数、符号数、关系边、循环依赖处数等）。

带上 `--query` 时，`plan` 节点会识别意图并裁掉与答案无关的节点：

```
$ pnpm analyze ./your-project --query "有循环依赖吗"

  ✓ plan   意图：依赖与循环 · 跳过 analyzeArchitecture、deadExports、narrate
```

| 意图 | analyzeArchitecture | deadExports | narrate |
|---|:---:|:---:|:---:|
| 全量审计（默认） | ✓ | ✓ | ✓ |
| 依赖与循环 | — | — | — |
| 架构与分层 | ✓ | — | ✓ |
| 质量与技术债 | — | ✓ | — |
| 语义检索 | — | — | — |

`dependency` 与 `quality` 恒在，它们的产出是报告的必填内容。被跳过的节点会连同理由写进报告的「执行计划」一节；想跑满加 `--full`。

## 追问

模型拿到 9 个只读工具，自己决定查什么、查几轮：

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
| `listDeadExports` | 没有引用者的导出，带「文件内是否还在用」 |
| `readSource` | 读源码片段，单次上限 120 行 |

工具调用与回答都是流式的，每条调用都标明查的是哪个文件——回答里的每个断言都能据此核对。轮次上限默认 8（`--max-steps` 可调），撞上限时会如实标注并交出已查到的线索。

## 改造

三条链路，共用同一套验证骨架：git 门禁 → 类型基线对比 → 写入 → 重扫对账 → 不符则回滚。

| | `import type` 破环 | 清理未使用的导出 | 模型提的方案 |
|---|---|---|---|
| 命令 | `--apply` | `--dead-exports --apply` | `--propose --execute <n>` |
| 变换 | 仅用于类型的导入升成 `import type` | 去掉 `export` / 删除整条声明 | 删整个文件 / 降级导出 / 连带删私有依赖 |
| 全自动 | ✅ | ✅ | ❌ **刻意不提供** |

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

```
$ pnpm refactor ./your-project --dead-exports

  ✓ 检出 9 个具名导出

可清理 3 个导出，9 → 6

  src/config.ts:2  internalPath  → 去掉 export
  src/format.ts:3  pad  → 去掉 export
  src/utils.ts:6   deadHelper    → 删除整条声明

1 个判定该清理但不敢动：
  src/effects.ts  registered  初始化表达式可能有副作用，删除会改变运行时行为
```

第三条链路让模型对「规则主动放弃的那部分」提方案。它输出的不是代码，而是结构化指令加一个可证伪的预测，逐条静态校验后由人挑选执行：

```
$ pnpm refactor ./your-project --propose

  · 候选池 11 个（工具主动放弃的部分）
  · 模型提了 3 条方案，开始逐条静态校验…
  · 校验通过 1 条，拦下 2 条，强制改写 1 处字段

[1] delete-file   风险 low
    目标  src/dead.ts  unusedHelper
    预测  导出 -2，文件 -1

2 条方案未通过静态校验（不进入上面的列表，但可查）：
    src/lib.ts#publicApi        预测导出减少 3 个，静态推算应为 1 个
    src/x.ts#totallyMadeUp      目标不在候选清单里

逐条复核后用 --execute <序号> 执行其中一条。
没有「全部执行」——这些改动正是工具判定为不安全、主动放弃的那些。
```

> ⚠️ 连带删除那一类**不保证行为等价**，风险等级被强制标为 `high`。当前是可回滚的原地修改，安全性来自 git 门禁（目标文件必须已跟踪且无未提交改动）。
>
> 清理有级联：删掉 A 之后，只被 A 用过的 B 才变成死代码，一轮不收敛。完整边界见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)，方案链路的设计见 [docs/PROPOSAL.md](docs/PROPOSAL.md)。

## Web 看板

```bash
pnpm dev      # API 3100 + 看板 5173
```

三种模式共用一套任务协议：**提交立刻返回 `taskId`，进度走 SSE，结果按需拉取**。

任务是**离线**的——发起之后可以断网、关页面、换设备，只有显式取消才会终止它：

| 能力 | 表现 |
|---|---|
| **断线续传** | 网络断了自动重连，只补发断开之后的进度，已生成的回答不会丢 |
| **刷新接回** | 刷新页面自动回到正在跑的那个任务 |
| **分享与寻址** | `taskId` 在地址栏里（`?task=<id>&mode=ask`），可以复制、收藏、发给别人 |
| **历史回看** | 关掉页面之后仍能从历史列表找回，任务归档跟着仓库走 |

同一件事重复提交会复用正在跑的那个任务；并发超过上限返回 429 并带 `Retry-After`。进程崩在半路的任务在历史里显示成 `interrupted`——不是完成、不是失败、也不是被谁取消的，是**没能跑到有结论**。

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

暴露上面那 9 个只读工具，外加一个 `refreshIndex`（改完代码后重建索引），全部标注 `readOnlyHint: true`。改造能力**没有**接入 MCP——写盘操作不该藏在一个标着只读的协议出口后面。

## Skill

MCP 给的是**能力**，Skill 给的是**流程**。[.agents/skills/frontend-repo-checkup](.agents/skills/frontend-repo-checkup/SKILL.md) 把「一个有经验的人会怎么用这套工具」写成了操作手册：先建立全局事实、再定位热点、检查分层是否倒置、判断循环依赖能否自动修、最后产出带行号的行动清单。

[Agent Skills](https://agentskills.io) 是开放标准，但发现路径由各客户端自己定，所以真身放在中立目录，客户端入口用相对符号链接指过去：

```
.agents/skills/frontend-repo-checkup/SKILL.md   ← 真身
.claude/skills/frontend-repo-checkup  ─┐
.cursor/skills/frontend-repo-checkup  ─┴─► 符号链接
```

想在**任意项目**里用（而不只是在本仓库里），链到用户级目录：

```bash
ln -s "$PWD/.agents/skills/frontend-repo-checkup" ~/.claude/skills/
ln -s "$PWD/.agents/skills/frontend-repo-checkup" ~/.cursor/skills/
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **代码结构**：模块分层、源码结构树、本地开发命令 |
| [docs/DESIGN.md](docs/DESIGN.md) | **设计取舍**：为什么这么做，以及不这么做的代价 |
| [docs/PROPOSAL.md](docs/PROPOSAL.md) | AI 提方案的边界设计：模型能提什么、明确不做什么、怎么校验 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 能力边界与路线图 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 依赖图缺边、改动不生效、端口占用 |
| [fixtures/README.md](fixtures/README.md) | 用例结构与五种结果语义 |
