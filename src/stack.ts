import { readFile } from "node:fs/promises";
import path from "node:path";
import type { StackResult } from "./model.js";

/**
 * 技术栈识别。
 *
 * 已知限制：主要依据 package.json 依赖判断，源码特征识别较弱。
 */
export async function detectStack(
  root: string,
  contents: Map<string, string>,
): Promise<StackResult> {
  const pkg = await readPackageJson(root);
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  const has = (name: string) => Boolean(deps[name]);
  const evidence: string[] = [];

  const framework = has("next")
    ? "Next.js"
    : has("nuxt")
      ? "Nuxt"
      : has("react")
        ? "React"
        : has("vue")
          ? "Vue"
          : null;
  if (framework) evidence.push(`package.json: ${framework}`);

  const buildTool = has("vite")
    ? "Vite"
    : has("webpack")
      ? "Webpack"
      : has("@rspack/core")
        ? "Rspack"
        : null;
  if (buildTool) evidence.push(`package.json: ${buildTool}`);

  const stateManagement = [
    has("@reduxjs/toolkit") || has("redux") ? "Redux" : "",
    has("zustand") ? "Zustand" : "",
    has("pinia") ? "Pinia" : "",
  ].filter(Boolean);

  const router = has("react-router") || has("react-router-dom")
    ? "React Router"
    : has("vue-router")
      ? "Vue Router"
      : null;

  const languages = [
    ...new Set(
      [...contents.keys()].map((file) => {
        if (file.endsWith(".ts") || file.endsWith(".tsx")) return "TypeScript";
        if (file.endsWith(".vue")) return "Vue SFC";
        return "JavaScript";
      }),
    ),
  ];

  if (contents.has("src/app/page.tsx") || contents.has("app/page.tsx")) {
    evidence.push("App Router entry detected");
  }

  const signals = [framework, buildTool, ...stateManagement, router].filter(Boolean).length;

  return {
    framework,
    frameworkVersion:
      framework === "React" ? deps.react : framework === "Vue" ? deps.vue : undefined,
    buildTool,
    stateManagement,
    language: languages,
    router,
    confidence: framework ? Math.min(0.99, 0.7 + signals * 0.06) : 0.25,
    evidence,
  };
}

async function readPackageJson(root: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    // JSON.parse("null") 与 JSON.parse("[]") 都不会抛，但后续取 .dependencies 会崩
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 纯源码仓库可能没有 package.json
    return {};
  }
}
