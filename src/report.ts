import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult, Narration } from "./model.js";

export async function renderReports(root: string, result: AnalysisResult): Promise<string[]> {
  const dir = path.join(root, ".reposurgeon", "reports");
  await mkdir(dir, { recursive: true });

  const outputs = [
    path.join(dir, "report.md"),
    path.join(dir, "report.html"),
    path.join(dir, "report.json"),
  ];

  await Promise.all([
    writeFile(outputs[0], renderMarkdown(result)),
    writeFile(outputs[1], renderHtml(result)),
    writeFile(outputs[2], JSON.stringify(result, null, 2)),
  ]);

  return outputs;
}

function renderMarkdown(result: AnalysisResult): string {
  const findings = result.findings.length
    ? result.findings.map(
        (finding) => `- [${finding.severity}] ${finding.message}（${finding.files.join(", ")}）`,
      )
    : ["- 未发现问题"];

  return [
    "# Repo Surgeon 分析报告",
    "",
    `生成时间：${result.generatedAt}`,
    "",
    "## 技术栈",
    `- 框架：${result.stack.framework ?? "未识别"}`,
    `- 构建工具：${result.stack.buildTool ?? "未识别"}`,
    `- 置信度：${result.stack.confidence}`,
    `- 证据：${result.stack.evidence.join("；") || "无"}`,
    "",
    "## 指标",
    `- 总分：${result.metrics.score}`,
    ...Object.entries(result.metrics.dimensions).map(([key, value]) => `- ${key}: ${value}`),
    "",
    ...narrationSection(result.narration),
    "## Findings",
    ...findings,
    "",
    "## Mermaid",
    "```mermaid",
    result.mermaid,
    "```",
  ].join("\n");
}

/** LLM 缺席时明确写出来，而不是让报告看起来少了一节 */
function narrationSection(narration?: Narration): string[] {
  if (!narration) {
    return ["## 架构解读", "", "_未配置模型，本次仅输出确定性分析结果。_", ""];
  }

  return [
    "## 架构解读",
    "",
    narration.summary,
    "",
    "### 分层推断",
    ...narration.layering.map((item) => `- **${item.layer}**：${item.role}`),
    "",
    "### 技术债优先级",
    ...narration.risks.flatMap((risk) => [
      `#### [${risk.severity}] ${risk.title}`,
      "",
      `- 判断依据：${risk.rationale}`,
      `- 建议：${risk.suggestion}`,
      `- 相关文件：${risk.relatedPaths.join("、") || "—"}`,
      "",
    ]),
  ];
}

/**
 * HTML 转义。
 *
 * 报告里插值的内容有三个来源都不可信：文件路径、LLM 生成的叙述、源码片段。
 * 架构叙述里出现 <Foo /> 这类组件名是常态，不转义会直接破坏页面结构。
 */
function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(result: AnalysisResult): string {
  const findings =
    result.findings
      .map(
        (finding) =>
          `${escapeHtml(finding.severity)}: ${escapeHtml(finding.message)} [${escapeHtml(finding.files.join(", "))}]`,
      )
      .join("\n") || "未发现问题";

  const narration = result.narration
    ? `<p>${escapeHtml(result.narration.summary)}</p><ul>${result.narration.risks
        .map(
          (risk) =>
            `<li><b>[${escapeHtml(risk.severity)}] ${escapeHtml(risk.title)}</b> — ${escapeHtml(risk.suggestion)}</li>`,
        )
        .join("")}</ul>`
    : "<p><i>未配置模型，本次仅输出确定性分析结果。</i></p>";

  return `<!doctype html>
<meta charset="utf-8">
<title>Repo Surgeon 分析报告</title>
<style>
  body { font: 15px system-ui; max-width: 960px; margin: 40px auto; line-height: 1.6; color: #24384f }
  code, pre { background: #f4f4f5; padding: 12px; display: block; overflow: auto }
  .diagram { background: #fff; border: 1px solid #e4e9f0; border-radius: 10px; padding: 16px; overflow: auto }
  .diagram-source { margin-top: 12px }
  summary { cursor: pointer; color: #6b7f96; font-size: 13px }
</style>
<h1>Repo Surgeon 分析报告</h1>
<p>技术栈：${escapeHtml(result.stack.framework ?? "未识别")} / ${escapeHtml(result.stack.buildTool ?? "未识别")}</p>
<h2>指标</h2>
<pre>${escapeHtml(JSON.stringify(result.metrics, null, 2))}</pre>
<h2>架构解读</h2>
${narration}
<h2>Findings</h2>
<pre>${findings}</pre>
<h2>架构图</h2>
<div class="diagram"><pre class="mermaid">${escapeHtml(result.mermaid)}</pre></div>
<details class="diagram-source">
  <summary>查看 Mermaid 源码</summary>
  <pre>${escapeHtml(result.mermaid)}</pre>
</details>
<script type="module">
  // 离线打开时 CDN 不可达，图会退化为源码文本，上面的 details 里也留了一份
  try {
    const { default: mermaid } = await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs");
    mermaid.initialize({ startOnLoad: true, theme: "base" });
  } catch {
    document.querySelector(".diagram").insertAdjacentHTML(
      "afterbegin",
      "<p style=\\"color:#6b7f96;font-size:13px\\">未能加载 Mermaid（离线环境），以下为图源码：</p>",
    );
  }
</script>`;
}
