import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * 根据目录特征反查绝对路径。
 *
 * 浏览器出于安全限制不会给出所选目录的绝对路径——`showDirectoryPicker` 只给句柄，
 * `webkitdirectory` 只给相对路径。但本服务就跑在同一台机器上，
 * 前端把目录特征发过来，这边在文件系统里定位即可。
 *
 * 光靠目录名远远不够：一台开发机上同名目录很常见（monorepo 的 apps/x、
 * 另一个仓库的 pages/x…），而它们的顶层结构还高度雷同，都有 src、package.json。
 * 因此把 package.json 的**完整内容哈希**作为主判据——同名项目的依赖与版本号
 * 几乎不可能逐字节一致，命中即可认定是同一个目录。
 */
export interface Fingerprint {
  entries?: string[];
  /** package.json 全文的 sha256 */
  packageHash?: string;
  packageName?: string;
}

export interface LocateMatch {
  path: string;
  score: number;
  /** package.json 内容完全一致，基本可认定就是所选目录 */
  exact: boolean;
  isRepo: boolean;
  analyzed: boolean;
}

export interface LocateResult {
  matches: LocateMatch[];
  /** 判据足够强，前端可直接采用第一个而不必再问用户 */
  confident: boolean;
}

/** 搜索预算：在 home 目录下无限翻找既慢又没必要 */
const MAX_DEPTH = 6;
const MAX_VISITS = 20000;
const MAX_MATCHES = 8;

/** package.json 内容命中的权重，要压倒任何结构相似度 */
const EXACT_SCORE = 1000;
/** 结构相似度满分 */
const STRUCTURE_SCORE = 100;
/** 领先次优这么多分，就认为判据足够强 */
const CONFIDENT_GAP = 40;

/** 不值得进入的目录，同时也大幅削减搜索量 */
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "Library",
  "Applications",
  "System",
  "Music",
  "Movies",
  "Pictures",
]);

export function locateDirectories(name: string, fingerprint: Fingerprint = {}): LocateResult {
  let matches: LocateMatch[] = [];

  // 由近及远逐个根目录搜索，每个根目录**独立**分配预算。
  //
  // 早期版本把所有根目录塞进同一个 BFS 队列共享预算，结果是：只要某一层
  // 存在超大目录（实测有个上层目录下挂着 5 万多个子目录），浅层就把预算吃光，
  // 深处真正要找的目录永远轮不到。逐个搜索还顺带带来「就近优先」的语义。
  for (const root of [...nearbyRoots(), homedir()]) {
    matches = search(root, name, fingerprint);
    if (matches.length > 0) break;
  }

  matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length);

  // 只有一个目录的 package.json 内容对得上，那就是它
  const exact = matches.filter((item) => item.exact);
  if (exact.length === 1) {
    return { matches: exact, confident: true };
  }

  const top = matches.slice(0, MAX_MATCHES);
  const confident =
    top.length === 1 || (top.length > 1 && top[0].score - top[1].score >= CONFIDENT_GAP);

  return { matches: top, confident };
}

/** 当前工作目录往上若干层，覆盖「项目与工具放在相邻目录」的常见布局 */
function nearbyRoots(): string[] {
  const roots: string[] = [];
  let current = process.cwd();

  for (let level = 0; level < 3; level += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    roots.push(parent);
    current = parent;
  }

  return roots;
}

function search(root: string, name: string, fingerprint: Fingerprint): LocateMatch[] {
  const found: LocateMatch[] = [];
  const seen = new Set<string>();
  const queue = [{ dir: root, depth: 0 }];
  let visits = 0;

  while (queue.length > 0 && visits < MAX_VISITS) {
    const { dir, depth } = queue.shift()!;
    if (depth > MAX_DEPTH || seen.has(dir)) continue;
    seen.add(dir);

    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      // 权限不足或路径失效，跳过即可
      continue;
    }
    visits += 1;

    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (child.name.startsWith(".") || SKIP.has(child.name)) continue;

      const full = path.join(dir, child.name);
      if (child.name === name) {
        found.push(evaluate(full, fingerprint));
        // 命中的目录本身不再往下找同名目录
        continue;
      }

      queue.push({ dir: full, depth: depth + 1 });
    }
  }

  return found;
}

function evaluate(dir: string, fingerprint: Fingerprint): LocateMatch {
  const packagePath = path.join(dir, "package.json");
  const isRepo = existsSync(packagePath);

  let score = 0;
  let exact = false;

  if (fingerprint.packageHash && isRepo) {
    if (hashFile(packagePath) === fingerprint.packageHash) {
      score += EXACT_SCORE;
      exact = true;
    }
  }

  score += structureScore(dir, fingerprint.entries ?? []);

  return {
    path: dir,
    score,
    exact,
    isRepo,
    analyzed: existsSync(path.join(dir, ".reposurgeon", "index.db")),
  };
}

/**
 * 顶层条目的 Jaccard 相似度。
 *
 * 用交并比而不是单纯的交集大小：否则条目特别多的目录会仅仅因为「碰巧包含」
 * 就拿到高分，而真正结构一致的目录反而排在后面。
 */
function structureScore(dir: string, entries: string[]): number {
  if (entries.length === 0) return 0;

  let actual: string[];
  try {
    actual = readdirSync(dir);
  } catch {
    return 0;
  }

  const expected = new Set(entries);
  const present = new Set(actual);
  const intersection = [...expected].filter((entry) => present.has(entry)).length;
  const union = new Set([...expected, ...present]).size;

  return union === 0 ? 0 : Math.round((intersection / union) * STRUCTURE_SCORE);
}

function hashFile(filePath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}
