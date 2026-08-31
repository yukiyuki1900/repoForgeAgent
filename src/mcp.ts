#!/usr/bin/env node
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodObject, ZodRawShape } from "zod";
import { loadEnv } from "./env.js";
import { buildIndex, createTools, type CodebaseIndex } from "./tools.js";

/**
 * MCP Server：把同一套只读工具通过标准协议交出去。
 *
 * `ask` 是「我们自己的模型用这些工具」，这里是「别人的模型用这些工具」——
 * 挂进 Claude Code / Cursor 之后，在编辑器里就能问「这个仓库有哪些循环依赖」。
 *
 * **工具定义没有复制一份。** 直接复用 `tools.ts` 里给 AI SDK 写的那套：
 * 从 tool 对象上取 description 与 zod schema，转成 MCP 的注册格式。
 * 两套协议共享同一个实现，也就不会出现「ask 修了 bug 而 MCP 没修」。
 */

/**
 * stdout 是 MCP 的协议通道。
 *
 * 这是接 stdio transport 最容易踩的坑：项目里 `graph.ts` 会打印 alias 解析
 * 统计、`storage.ts` 会打印降级告警——任何一行 `console.log` 混进 stdout
 * 都会让客户端解析 JSON-RPC 失败，且报错完全看不出根因。
 *
 * 所以在建立传输之前先把 console 的输出面改到 stderr。日志不丢，只是换条道。
 */
function redirectLogsToStderr(): void {
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.warn = (...args: unknown[]) => console.error(...args);
}

/**
 * 解析要分析的仓库。
 *
 * 优先级：命令行参数 > 环境变量 > 当前工作目录。
 * MCP 客户端的配置里通常写死一个路径，所以参数排第一。
 */
function resolveRoot(): string {
  const fromArgv = process.argv[2];
  const fromEnv = process.env.REPOFORGE_ROOT;
  return path.resolve(fromArgv || fromEnv || process.cwd());
}

/**
 * 索引惰性构建并缓存。
 *
 * 一次全量解析要几秒，每个工具调用都重建一遍不可接受。
 * 代价是索引会随代码修改过期——所以额外提供了 `refreshIndex`，
 * 让使用者在改完代码后显式重建，而不是我们去猜什么时候该失效。
 */
function createIndexCache(root: string) {
  let cached: CodebaseIndex | undefined;

  return {
    async get(): Promise<CodebaseIndex> {
      if (!cached) cached = await buildIndex(root);
      return cached;
    },
    clear(): void {
      cached = undefined;
    },
  };
}

/**
 * 工具结果转成 MCP 的返回格式。
 *
 * 源码单独用代码块，其余结构化数据用 JSON——把几十行源码塞进 JSON 字符串，
 * 转义符会占掉大量 token，模型读起来也费劲。
 */
function formatResult(value: unknown): string {
  if (value && typeof value === "object" && "source" in value) {
    const { source, ...rest } = value as Record<string, unknown>;
    return [JSON.stringify(rest, null, 2), "", "```", String(source), "```"].join("\n");
  }
  return JSON.stringify(value, null, 2);
}

/**
 * AI SDK 的 tool 对象：description + zod schema + execute。
 *
 * 这里只声明 MCP 侧真正用到的三个字段。AI SDK 的完整类型带着每个工具各自的
 * 参数与返回值泛型，逐个对上既没必要也做不到——注册时本来就要按名字动态遍历。
 */
interface AiSdkTool {
  description?: string;
  parameters: ZodObject<ZodRawShape>;
  execute?: (args: never, options: never) => PromiseLike<unknown>;
}

/** 工具集按名字遍历，泛型信息在这一步必然丢失 */
function asToolMap(tools: object): Record<string, AiSdkTool> {
  return tools as unknown as Record<string, AiSdkTool>;
}

async function main(): Promise<void> {
  redirectLogsToStderr();
  loadEnv();

  const root = resolveRoot();
  const cache = createIndexCache(root);

  const server = new McpServer({
    name: "repoforge",
    version: "0.1.0",
  });

  // 先建一次索引，把工具定义取出来。这一步顺便验证了路径可用——
  // 与其在第一次调用工具时才报「目录里没有源码」，不如启动就失败
  const index = await cache.get();
  const { tools } = createTools(index);

  for (const [name, definition] of Object.entries(asToolMap(tools))) {
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.parameters.shape,
        annotations: {
          // 八个工具全部只读，如实声明——客户端会据此决定要不要提示用户确认
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          // 索引可能已被 refreshIndex 换掉，每次取当前的那一份
          const current = await cache.get();
          const live = asToolMap(createTools(current).tools);
          const result = await live[name].execute?.(args as never, {} as never);

          return { content: [{ type: "text" as const, text: formatResult(result) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            isError: true,
            content: [{ type: "text" as const, text: `工具执行失败：${message}` }],
          };
        }
      },
    );
  }

  server.registerTool(
    "refreshIndex",
    {
      description: "重新扫描仓库并重建索引。修改代码之后调用，否则依赖关系仍是上次扫描的结果。",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      cache.clear();
      const rebuilt = await cache.get();
      return {
        content: [
          {
            type: "text" as const,
            text: `索引已重建：${rebuilt.files.length} 个文件 · ${rebuilt.symbols.length} 个符号 · ${rebuilt.edges.length} 条关系边 · ${rebuilt.cycles.length} 处循环依赖`,
          },
        ],
      };
    },
  );

  console.error(
    `[repoforge-mcp] ${root}\n` +
      `[repoforge-mcp] ${index.files.length} 个文件 · ${index.symbols.length} 个符号 · ` +
      `${index.edges.length} 条关系边 · ${index.cycles.length} 处循环依赖`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(`[repoforge-mcp] 启动失败：${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
