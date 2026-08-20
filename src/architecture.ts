import type { FileNode, RelationEdge, SymbolNode } from "./model.js";

export interface ArchitectureReport {
  directories: Array<{
    path: string;
    responsibility: string;
    files: number;
    inbound: number;
    outbound: number;
  }>;
  layers: Array<{ name: string; paths: string[]; dependsOn: string[] }>;
  componentTopology: { components: string[]; edges: Array<{ from: string; to: string }> };
  mermaid: string;
}

const RESPONSIBILITIES: Record<string, string> = {
  app: "应用入口与路由层",
  pages: "页面层",
  views: "页面层",
  features: "业务功能层",
  components: "通用组件层",
  hooks: "React Hooks / 可复用逻辑",
  composables: "Vue Composables",
  stores: "状态管理层",
  services: "服务访问层",
  api: "接口访问层",
  utils: "通用工具层",
  lib: "基础设施层",
  config: "工程配置层",
};

const LAYER_NAMES = ["pages", "features", "components", "hooks", "stores", "services", "utils"];

/**
 * 架构逆向解析。
 *
 * 已知限制：按第一层目录名推断职责与分层，
 * 尚未基于 AST、依赖方向与真实模块语义做判定，准确度有限。
 */
export function analyzeArchitecture(
  files: FileNode[],
  symbols: SymbolNode[],
  edges: RelationEdge[],
): ArchitectureReport {
  const byId = new Map(files.map((file) => [file.id, file]));

  const groups = new Map<string, FileNode[]>();
  for (const file of files) {
    const topLevel = file.path.split("/")[0] || ".";
    groups.set(topLevel, [...(groups.get(topLevel) ?? []), file]);
  }

  const directories = [...groups]
    .map(([directory, grouped]) => {
      const ids = new Set(grouped.map((file) => file.id));
      return {
        path: directory,
        responsibility: RESPONSIBILITIES[directory] ?? "待识别模块",
        files: grouped.length,
        inbound: edges.filter((edge) => ids.has(edge.to) && !ids.has(edge.from)).length,
        outbound: edges.filter((edge) => ids.has(edge.from) && !ids.has(edge.to)).length,
      };
    })
    .sort((a, b) => b.files - a.files);

  const layers = LAYER_NAMES.map((name) => ({
    name,
    paths: directories.filter((item) => item.path === name).map((item) => item.path),
    dependsOn: [] as string[],
  })).filter((layer) => layer.paths.length);

  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    const from = byId.get(edge.from)?.path.split("/")[0];
    const to = byId.get(edge.to)?.path.split("/")[0];
    const fromLayer = layers.find((layer) => layer.name === from);
    if (!fromLayer || !to || to === from) continue;
    if (!fromLayer.dependsOn.includes(to)) fromLayer.dependsOn.push(to);
  }

  const components = symbols.filter((symbol) => symbol.kind === "component");
  const componentFileIds = new Set(components.map((symbol) => symbol.fileId));
  const componentEdges = edges
    .filter((edge) => componentFileIds.has(edge.from) && componentFileIds.has(edge.to))
    .map((edge) => ({
      from: byId.get(edge.from)?.path ?? edge.from,
      to: byId.get(edge.to)?.path ?? edge.to,
    }));

  const mermaid = [
    "graph TD",
    ...layers.map((layer) => `  ${layer.name}[${layer.name}]`),
    ...layers.flatMap((layer) => layer.dependsOn.map((target) => `  ${layer.name} --> ${target}`)),
  ].join("\n");

  return {
    directories,
    layers,
    componentTopology: { components: components.map((symbol) => symbol.name), edges: componentEdges },
    mermaid,
  };
}
