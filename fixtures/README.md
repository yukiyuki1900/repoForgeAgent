# Fixture 回归评估

把分析器当成一个 CLI 程序来测：不看模型说了什么，只校验它在固定输入上产出的**事实**——依赖环、组件清单、关系边。这样每一条能力都是可回归、可量化的。

## 运行

```bash
pnpm eval
```

## 用例结构

```
fixtures/<序号>-<用例名>/
├── expected.json     # 期望与状态声明
└── src/              # 一个最小化的仓库
```

`expected.json`：

| 字段 | 说明 |
|---|---|
| `title` | 用例标题 |
| `status` | `expected-pass`：当前必须通过；`known-failure`：当前已知做不到 |
| `why` | 为什么现在做不到——写清楚失败的根因，而不是笼统的「未实现」 |
| `requires` | 该用例依赖的可选包；缺失时标记为 `SKIPPED` 而不是判为回归 |
| `expect.cycles` | 期望检出的循环依赖，每项是构成环的文件路径集合（比较时忽略顺序） |
| `expect.cycleCount` | 环的**总数**。用来断言「不该有环」——只写 `cycles: []` 等于零条断言 |
| `expect.components` | 期望被识别为 `component` 的符号名 |
| `expect.edges` | 期望存在的关系边 `{ from, to, kind }` |
| `expect.metrics` | 维护性指标：`score` 总分、`dimensionCount` 参与评分的维度数 |
| `expect.refactor` | 改造计划：`candidates` 可拆边（数量必须精确匹配）、`blocked` 不可拆边及原因、`cyclesAfter` 改造后剩余环数 |
| `expect.architecture` | 架构聚合：`sourceRoot` 剥离出的公共前缀、`modules` 必须聚出的模块、`minMermaidLines` 图的最小行数 |
| `expect.narration` | 送给 LLM 前的上下文摘要：`maxEstimatedTokens` 规模上限、`modules` 必须保留的模块聚合、`cycleCuts` 环上建议切点 |

## 四种结果

| 结果 | 含义 | 是否阻塞 |
|---|---|---|
| `PASS` | `expected-pass` 用例通过 | — |
| `KNOWN-FAIL` | `known-failure` 用例仍然失败，符合当前预期 | 否 |
| `REGRESSION` | `expected-pass` 用例挂了，能力出现回退 | **是**，退出码 1 |
| `FIXED` | `known-failure` 用例开始通过，需把 `status` 改为 `expected-pass` | 否，但会提示 |
| `SKIPPED` | `requires` 声明的可选依赖没装，用例未执行 | 否 |

这样设计的目的：**已知的短板不会污染红绿信号，但也不会被悄悄忘掉。** 每次补齐一项能力，就有一个用例从 `KNOWN-FAIL` 变成 `FIXED`，通过率的变化即是能力提升的证据。

## 当前用例

| 用例 | 状态 | 覆盖的能力 |
|---|---|---|
| `01-relative-cycle` | expected-pass | 对照组：相对路径 import 构成的环 |
| `02-alias-cycle` | expected-pass | tsconfig paths alias 导入解析 |
| `03-dynamic-import-cycle` | expected-pass | 动态 `import()` 边提取 |
| `04-arrow-component` | expected-pass | 箭头函数组件识别 |
| `05-jsx-render-edge` | expected-pass | JSX render 关系边提取 |
| `06-narration-context` | expected-pass | 送给 LLM 之前的上下文压缩与环切点计算 |
| `07-empty-repo` | expected-pass | 空仓库不凭空造分 |
| `08-nested-cycles` | expected-pass | 交织环合并为单个强连通分量（保护迭代版 Tarjan） |
| `09-src-layout` | expected-pass | `src/` 前缀下的分层项目必须能聚出模块 |
| `10-vue-sfc` | expected-pass | Vue SFC 的 alias 导入与 template 组件引用 |
| `11-vite-alias` | expected-pass | `vite.config` 里 `resolve.alias` 的静态提取 |
| `12-alias-shorthand` | expected-pass | alias 声明为变量并以简写属性写入 `resolve` |
| `13-type-only-cycle` | expected-pass | 纯类型环可用 `import type` 打破 |
| `14-runtime-cycle` | expected-pass | 运行时环不可自动修复（保护误报率） |
| `15-decorator-metadata-unused` | expected-pass | 开了 `emitDecoratorMetadata` 但不用装饰器时仍可改造 |
| `16-type-only-edge` | expected-pass | 已写成 `import type` 的边不构成运行时环 |
| `17-verbatim-inline-type` | expected-pass | `verbatimModuleSyntax` 下内联 `type` 修饰符仍是运行时边 |

## 改造闭环的端到端用例

`pnpm eval` 校验的是**判定**，`pnpm test`（[tests/apply.test.ts](../tests/apply.test.ts)）校验的是**执行**——两件事不能混为一谈：返回值说「已应用」而磁盘没变，是最坏的一种绿灯。

每个用例都从 fixture 复制出一个真实的、已提交的 git 仓库，跑完再读回文件内容对账：

| 用例 | 断言的行为 |
|---|---|
| 纯类型环 | 磁盘上真的出现 `import type`，函数体原样保留，重跑分析环归零，diff 与报告落盘 |
| 模拟与实测对不上 | 注入两条源码里不存在的边制造预测偏差 → 必须还原到改动前，但 diff 要留档 |
| 运行时环 | 没有可拆的边，一个字节都不写，`git status` 保持干净 |
| 目标文件有未提交改动 | 拒绝执行，用户的改动原封不动 |
| 目标文件不受 git 跟踪 | 拒绝执行——没有可靠回滚手段就不动用户的代码 |

## 解析器替换前后

02–05 建立时全部是 `known-failure`，共同根因是 `src/graph.ts` 用正则而非 AST 提取符号与依赖。改用 ts-morph + TypeScript 模块解析后，四个用例同时转为通过：

| 用例 | 正则实现 | AST 实现 |
|---|---|---|
| `02-alias-cycle` | 0 依赖边，0 个环 | 2 依赖边，1 个环 |
| `03-dynamic-import-cycle` | 1 依赖边，0 个环 | 2 依赖边，1 个环 |
| `04-arrow-component` | 1/2 组件（漏 `Card`） | 2/2 组件 |
| `05-jsx-render-edge` | 无 render 边 | 产出 render 边 |
| **通过率** | **1/5（20%）** | **5/5（100%）** |

`02-alias-cycle` 那行最能说明问题：两个文件明明互相 import 构成环，正则实现扫出 3 个符号却是 **0 条依赖边**——alias 导入被整条丢弃，环自然无从谈起。
