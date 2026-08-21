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
| `expect.cycles` | 期望检出的循环依赖，每项是构成环的文件路径集合（比较时忽略顺序） |
| `expect.components` | 期望被识别为 `component` 的符号名 |
| `expect.edges` | 期望存在的关系边 `{ from, to, kind }` |
| `expect.metrics` | 维护性指标：`score` 总分、`dimensionCount` 参与评分的维度数 |
| `expect.narration` | 送给 LLM 前的上下文摘要：`maxEstimatedTokens` 规模上限、`modules` 必须保留的模块聚合、`cycleCuts` 环上建议切点 |

## 四种结果

| 结果 | 含义 | 是否阻塞 |
|---|---|---|
| `PASS` | `expected-pass` 用例通过 | — |
| `KNOWN-FAIL` | `known-failure` 用例仍然失败，符合当前预期 | 否 |
| `REGRESSION` | `expected-pass` 用例挂了，能力出现回退 | **是**，退出码 1 |
| `FIXED` | `known-failure` 用例开始通过，需把 `status` 改为 `expected-pass` | 否，但会提示 |

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
