# 故障排查

## 依赖边比预期少 / 循环依赖检测不出来

看分析开头有没有这类告警：

```
[graph] 有 alias 导入无法解析（@/pages… × 40、@/components… × 28）
```

说明 alias 没被解析到，依赖图会缺边。工具会读 tsconfig 的 `paths` 与 vite / webpack 配置里的 `resolve.alias`，但不执行配置文件——如果 alias 由插件动态注入，或定义在被 `import` 的独立文件里，就读不到。此时在 tsconfig 里补上同样的 `paths` 即可。

alias 生效时会有对应日志，可用来确认：

```
[graph] alias @ → src  来自 vite.config.ts
[graph] alias @ 解析成功 84 处
```

> 每个 import 会被解析两次（产出依赖边一次、收集 render 边的导入表一次），所以「解析成功 84 处」对应约 42 条新边。

另一类提示：

```
[graph] 12 个模块解析到了仓库之外，未纳入依赖图（monorepo 兄弟包需要单独分析）
```

## 改了代码却不生效

`tsx` **不是 watch 模式**，改完必须重启进程。

更隐蔽的情况是旧进程没退干净。用 `pnpm api & pnpm web:dev` 启动时，Ctrl+C 只会中断前台的 Vite，后台的 API 会活下来继续占着端口——下次启动时新进程抢不到端口直接退出，而页面照常打开，**连的是跑着旧代码的旧进程**。

「已修复的警告又出现」「日志数值退回到几个版本之前」基本都是这个原因。

```bash
pnpm stop      # 终止残留进程
pnpm dev       # 启动前会主动检查端口占用并拦下这种情况
```

`pnpm stop` 只终止**确认属于本项目**的进程（命令行需同时匹配项目路径与已知入口）；端口被其它程序占用时只提示不动手，确需强制终止用 `pnpm stop --force`。

## 页面能打开但接口全不通

多半是 API 没起来。**不要用 `pnpm api & pnpm web:dev`**——两者输出混在一起，API 的启动失败会被 Vite 的成功日志盖过去。改用：

```bash
pnpm dev
```

输出带 `[api]` / `[web]` 前缀，任一进程异常退出会立刻停掉另一个并报错。

另一个可能是端口不一致。本项目刻意**不读通用的 `PORT`**（容器、PaaS、CI 普遍会注入它，一旦读取 API 就会监听意外端口，而前端 proxy 仍指向 3100）。要改端口用 `REPOSURGEON_API_PORT` / `REPOSURGEON_WEB_PORT`。

## 看板上的数据是假的

刚打开看板时展示的是演示数据，顶部有橙色 `DEMO 数据` 标识。三种数据来源：

| 场景 | 数据 |
|---|---|
| 刚打开，未操作 | Demo 假数据（有标识） |
| 点「开始分析」 | 实时分析结果 |
| 该仓库被 CLI 分析过 | 提示历史记录，点击加载 |

CLI 与看板是独立进程、内存不共享，`pnpm analyze` 的结果**不会自动出现在看板上**——需要在看板里填入同一个仓库路径，再点「加载最近一次结果」。

## 架构图是空的 / 渲染失败

看板会区分两种情况：本次确实没产出架构图，与渲染报错（会显示具体原因并折叠展示图源码）。

如果 `report.html` 里的图没渲染出来，可能是离线环境——报告通过 CDN 加载 mermaid，加载失败时会退化为源码文本，`details` 里也留了一份。

## 分析直接失败

```
在 /path/to/xxx 下没有找到可分析的源码文件（.ts / .tsx / .js / .jsx / .vue）
```

绝大多数情况是路径指向了项目的上级目录，或源码全部落在 `node_modules` / `dist` 等被忽略的目录里。

## 依赖缺失

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vue/compiler-sfc'
```

拉取新代码后需要重新安装：

```bash
pnpm install
```

`@vue/compiler-sfc` 是可选依赖，缺失时 `.vue` 会退回正则解析（alias 导入与 template 组件引用会缺失）并打印提示，不影响其它功能。
