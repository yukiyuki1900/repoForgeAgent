import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP Server 的端到端。
 *
 * 这一层只能真连：协议握手、schema 转换、stdout 是否干净，
 * 没有一项能靠读代码看出来。启动的是真的子进程，走的是真的 stdio 传输。
 *
 * 故意选 `11-vite-alias` 作为目标仓库——它会触发 graph.ts 打印
 * `[graph] alias @ → src` 这类日志。如果日志没被改道到 stderr，
 * 它们会混进 JSON-RPC 通道，握手直接失败。**能连上本身就是一条断言。**
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let client: Client;

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

before(async () => {
  client = new Client({ name: "repoforge-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(ROOT, "src/mcp.ts"), path.join(ROOT, "fixtures/11-vite-alias")],
      cwd: ROOT,
    }),
  );
});

after(async () => {
  await client?.close();
});

describe("MCP Server", () => {
  it("暴露全部只读工具，外加一个索引刷新", async () => {
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "findSymbol",
      "getDependencies",
      "getDependents",
      "getFileSummary",
      "listCycles",
      "listHotspots",
      "readSource",
      "refreshIndex",
      "searchFiles",
    ]);
  });

  it("每个工具都如实声明了只读", async () => {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} 缺少 readOnlyHint`);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} 的 openWorldHint 不对`);
    }
  });

  it("zod schema 被转成带描述的 JSON Schema", async () => {
    const { tools } = await client.listTools();
    const readSource = tools.find((tool) => tool.name === "readSource")!;

    const schema = readSource.inputSchema as {
      type: string;
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };

    assert.equal(schema.type, "object");
    assert.deepEqual(Object.keys(schema.properties).sort(), ["endLine", "path", "startLine"]);
    // 参数描述必须一起过来，否则模型只能靠参数名猜语义
    assert.ok(schema.properties.path.description);
    assert.deepEqual(schema.required?.sort(), ["endLine", "path", "startLine"]);
  });

  it("查询工具返回的是真实分析结果", async () => {
    const result = await client.callTool({ name: "searchFiles", arguments: { keyword: "src/" } });
    const payload = JSON.parse(textOf(result)) as { total: number; rows: Array<{ path: string }> };

    assert.ok(payload.total > 0);
    assert.ok(payload.rows.every((row) => row.path.startsWith("src/")));
  });

  it("源码用代码块返回，不塞进 JSON 字符串", async () => {
    const result = await client.callTool({
      name: "readSource",
      arguments: { path: "src/utils/format.ts", startLine: 1, endLine: 3 },
    });
    const text = textOf(result);

    // 元信息是 JSON，源码在代码块里——几十行源码塞进 JSON 字符串，
    // 转义符会占掉大量 token
    assert.match(text, /"totalLines"/);
    assert.match(text, /```/);
    assert.equal(text.includes("\\n"), false, "源码不该以转义形式出现");
  });

  it("路径写错时同样返回候选，与 ask 模式行为一致", async () => {
    const result = await client.callTool({
      name: "getFileSummary",
      arguments: { path: "完全不存在的路径.ts" },
    });
    const payload = JSON.parse(textOf(result)) as { error?: string; hint?: string };

    assert.ok(payload.error);
    assert.ok(payload.hint);
  });

  it("refreshIndex 重建索引并汇报规模", async () => {
    const result = await client.callTool({ name: "refreshIndex", arguments: {} });
    assert.match(textOf(result), /索引已重建：\d+ 个文件/);
  });
});
