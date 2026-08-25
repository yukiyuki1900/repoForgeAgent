/**
 * 执行计划：这一轮该跑哪些节点。
 *
 * 为什么需要它——先看一次真实运行的耗时分布（319 文件的 Vue 仓库）：
 *
 *   parseSemantic      4737ms
 *   narrate           18156ms   ← 单节点占总耗时 79%
 *   其余 9 个节点合计   ~160ms
 *
 * 结论很直白：**四个确定性分析器加起来 35ms，路由它们是自欺欺人**。
 * 真正值得决策的是 LLM 节点。所以这里不搞「每个节点都过一遍条件判断」的
 * 表演，只在有真实成本差异的地方做取舍，并把每个取舍的理由如实记下来。
 *
 * 决策用规则而不是模型：意图分类是低维、可枚举、要求可复现的判断，
 * 交给 LLM 只会换来延迟、不确定性，以及「幻觉出一个不存在的节点名」的风险。
 * 这和项目一贯的边界一致——LLM 负责解释，不负责控制流。
 * （`createAnalysisGraph` 仍然允许注入自定义 planner，架构上并不锁死。）
 */

/** 本次运行想解决什么问题 */
export type Intent = "full-audit" | "dependency" | "architecture" | "quality" | "search";

/**
 * 可被裁剪的节点。
 *
 * `dependency` 与 `quality` 不在其中：`AnalysisResult` 的 `metrics` 与
 * 循环依赖 findings 是报告的必填内容，跳过它们等于产出一份残缺却看不出残缺的报告。
 * 何况两者合计 17ms，省下来也没有意义。
 */
export type OptionalNode = "analyzeArchitecture" | "frontend" | "narrate";

export interface PlanDecision {
  node: string;
  run: boolean;
  /** 为什么这么定——裁剪不能是静默的 */
  why: string;
}

export interface ExecutionPlan {
  intent: Intent;
  run: OptionalNode[];
  decisions: PlanDecision[];
  /** 一句话概括这次的排布 */
  rationale: string;
}

export interface PlanInput {
  query?: string;
  /** 有没有可用的模型。没有就别进 narrate 再降级，直接不走这条边 */
  hasModel: boolean;
  /** 用户显式要求全量，覆盖所有意图裁剪 */
  full?: boolean;
}

/**
 * 意图识别规则。
 *
 * 顺序即优先级，从具体到宽泛：「架构里有没有循环依赖」应该判成 dependency，
 * 而不是因为出现「架构」二字就去生成一篇架构叙述。
 */
const INTENT_RULES: Array<{ intent: Intent; pattern: RegExp }> = [
  {
    intent: "dependency",
    pattern: /循环依赖|依赖环|环形|成环|耦合|依赖关系|circular|cycle|coupling|depend/i,
  },
  {
    intent: "quality",
    pattern: /质量|复杂度|维护性|技术债|坏味道|大文件|圈复杂度|quality|complexity|debt|smell/i,
  },
  {
    intent: "architecture",
    pattern: /架构|分层|模块划分|目录结构|拓扑|architecture|layer|module|structure/i,
  },
];

/** 每种意图需要哪些可选节点 */
const PROFILES: Record<Intent, OptionalNode[]> = {
  "full-audit": ["analyzeArchitecture", "frontend", "narrate"],
  // 只问环：架构图、前端专项、架构叙述都不是答案的一部分
  dependency: [],
  architecture: ["analyzeArchitecture", "narrate"],
  quality: ["frontend"],
  // 检索要的是「哪几个文件」，一段架构散文帮不上忙
  search: [],
};

const WHY_NEEDED: Record<OptionalNode, string> = {
  analyzeArchitecture: "本次意图需要模块聚合与架构图",
  frontend: "本次意图需要前端专项检查",
  narrate: "本次意图需要模型给出解释性叙述",
};

export function planExecution(input: PlanInput): ExecutionPlan {
  const intent = input.full ? "full-audit" : detectIntent(input.query);
  const wanted = new Set<OptionalNode>(PROFILES[intent]);

  // 没有模型就不该走到 narrate 里再降级：那样白等一次节点调度，
  // 进度条上还会出现一个「跳过」的节点，看起来像是失败了
  if (!input.hasModel) wanted.delete("narrate");

  const decisions: PlanDecision[] = (
    ["analyzeArchitecture", "frontend", "narrate"] as OptionalNode[]
  ).map((node) => ({
    node,
    run: wanted.has(node),
    why: explain(node, wanted.has(node), intent, input),
  }));

  decisions.push({
    node: "retrieveContext",
    run: Boolean(input.query),
    why: input.query ? "提供了检索问题" : "未提供检索问题，无需检索",
  });

  return { intent, run: [...wanted], decisions, rationale: rationaleOf(intent, input) };
}

function detectIntent(query?: string): Intent {
  const trimmed = query?.trim();
  if (!trimmed) return "full-audit";

  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(trimmed)) return rule.intent;
  }
  return "search";
}

function explain(node: OptionalNode, run: boolean, intent: Intent, input: PlanInput): string {
  if (run) return WHY_NEEDED[node];
  if (node === "narrate" && !input.hasModel) {
    return "未配置模型，直接不走这条边，而不是进入节点后再降级";
  }
  return `意图为「${INTENT_LABEL[intent]}」，${node} 的产出不在答案里`;
}

const INTENT_LABEL: Record<Intent, string> = {
  "full-audit": "全量审计",
  dependency: "依赖与循环",
  architecture: "架构与分层",
  quality: "质量与技术债",
  search: "语义检索",
};

function rationaleOf(intent: Intent, input: PlanInput): string {
  if (input.full) return "显式要求全量分析，不做任何裁剪";
  if (intent === "full-audit") return "未提供检索问题，按全量审计执行";
  return `问题被识别为「${INTENT_LABEL[intent]}」，只跑与答案相关的节点`;
}

/** 供 CLI 进度行使用的一句话摘要 */
export function summarizePlan(plan: ExecutionPlan): string {
  const skipped = plan.decisions.filter((item) => !item.run);
  const label = INTENT_LABEL[plan.intent];
  return skipped.length === 0
    ? `意图：${label} · 全部节点执行`
    : `意图：${label} · 跳过 ${skipped.map((item) => item.node).join("、")}`;
}

export { INTENT_LABEL };
