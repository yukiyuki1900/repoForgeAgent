# 已知限制

诚实列出，避免误判能力边界。

## 性能与资源

| 限制 | 说明 |
|---|---|
| 全量解析，无增量 | `scanner.ts` 已计算 `contentHash`，但尚未用于跳过未变更文件 |
| 模块解析无缓存 | 每个 import 都走一次 `ts.resolveModuleName`，未传 `ModuleResolutionCache`，大仓上是主要耗时来源 |
| ts-morph Project 不释放 | 全量保留 AST，万级文件仓库的内存占用需要实测 |
| `runs` 表只增不删 | 每次分析插入一份完整报告 JSON，`.reposurgeon/index.db` 会随运行次数膨胀 |

## 解析覆盖面

| 限制 | 说明 |
|---|---|
| 单仓 tsconfig | 只读取仓库根目录的 tsconfig；monorepo 子包各自的 `paths` 尚未逐包解析 |
| alias 只做静态提取 | 支持对象字面量、数组形式、简写属性与同文件内变量引用；若 alias 由插件动态注入或定义在被 `import` 的独立文件里则读不到，此时会打印告警 |
| 无调用边 / Hook 使用边 | 当前只有 import 与 render 两类关系 |
| 架构分层按目录名推断 | 模块划分会先剥离公共前缀（如 `src/`）再聚合，但分层判定仍以目录名为准，尚未结合依赖方向 |

## 检索与恢复

| 限制 | 说明 |
|---|---|
| 检索未接入 FTS5 与向量 | SQLite 建了 `files_fts` 表但主流程用的是关键词匹配；中文长尾表达依赖 LLM 查询计划 |
| checkpoint 不支持恢复 | 状态快照写入了 SQLite，但没有基于它的 resume 逻辑；LangGraph 侧用的是进程内 `MemorySaver` |

## 交互

| 限制 | 说明 |
|---|---|
| 目录反查依赖同机后端 | 浏览器不给绝对路径，只能靠后端按目录特征搜索；搜索范围限定在 cwd 周边与 home 目录 |
| 原生目录选择器兼容性 | `showDirectoryPicker` 仅 Chrome / Edge 支持，其它浏览器自动回退到服务端目录浏览器 |
| 前端构建产物需要 API 地址配置 | 相对路径 `/analysis` 依赖 vite dev proxy，静态托管 `web/dist` 时无法访问 API |

## 路线图

1. **增量索引** — 用 `contentHash` 跳过未变更文件，把大仓重复分析的成本降下来
2. **大仓性能基线** — 在万级文件真实仓库上测出解析耗时曲线
3. **关系边扩展** — 函数调用边、Hook 使用边、Store 使用边
4. **分层推断结合依赖方向**，而不只看目录名
5. **从分析走向改造** — LLM 输出结构化改造指令，由 ts-morph 确定性落地，用 tsc / 测试做验证闭环
