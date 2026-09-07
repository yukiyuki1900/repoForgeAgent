/**
 * 记住「刚才提交的那个任务」，好让刷新之后能接回去。
 *
 * ## 为什么需要它
 *
 * 后台任务是离线的——用户可以断网、关页面，任务照跑。但这条承诺此前
 * **在界面上是断的**：服务端记得那个任务，前端刷新一下就忘了 `taskId`，
 * 于是「还在跑」和「从来没跑过」在页面上长得一模一样。
 *
 * 存的东西极少（一个 id 加几个用于校验的字段），因为**真相在服务端**。
 * 这里存的不是状态，只是一把回去认领的钥匙。
 *
 * ## 三条防御，都不是可选的
 *
 * 1. **`localStorage` 可能根本用不了**（隐私模式、被策略禁用、配额满）。
 *    所有读写都包 try/catch：**一个便利功能不该让页面打不开**。
 * 2. **存的内容可能是脏的**（用户手改、上个版本的格式、别的应用撞了 key）。
 *    校验不过一律当作没有，绝不半信半疑地用一半。
 * 3. **可能已经过期**。任务最长十分钟，超过半小时的记录必然无效，
 *    留着只会让用户看到一个早就结束的东西。
 *
 * 这三条和 `trace.ts` 解析 traceparent 是同一个态度：
 * **这类辅助信息宁可当作没有，也不能让主流程失败。**
 */

const PREFIX = "reposurgeon:task:";

/**
 * 超过这个时间的记录直接丢弃。
 *
 * 上界参考任务本身的兜底超时（最长的 `ask` 是 10 分钟），
 * 留三倍余量——**宁可多存一会儿也别误丢**：丢了的代价是用户接不回
 * 正在跑的任务，而多留一会儿的代价只是恢复时探一次发现它已经结束了。
 */
const MAX_AGE_MS = 30 * 60_000;

export interface ResumableTask {
  taskId: string;
  /** 提交时的仓库路径。换了仓库就不该再接回上一个 */
  root: string;
  /** 毫秒时间戳，用来判过期 */
  startedAt: number;
}

/**
 * 按 kind 分开存。
 *
 * 用一个 key 存所有的话，用户在分析跑着的时候提个问，问答会把分析那条
 * 覆盖掉——**而它们在界面上是三块独立的区域，本来就该各恢复各的。**
 */
const keyOf = (kind: string): string => `${PREFIX}${kind}`;

export function remember(kind: string, task: ResumableTask): void {
  try {
    localStorage.setItem(keyOf(kind), JSON.stringify(task));
  } catch {
    // 存不下就算了。恢复是锦上添花，不值得为它打断任何事
  }
}

export function forget(kind: string): void {
  try {
    localStorage.removeItem(keyOf(kind));
  } catch {
    // 同上
  }
}

/**
 * 取回上次提交的任务；没有、脏了、过期了，一律返回 undefined。
 *
 * `root` 必须对得上：用户换了仓库还接回上一个仓库的任务，
 * 界面会显示成「正在分析当前仓库」，而实际跑的是另一个——
 * **这种错比没有恢复功能糟糕得多**。
 */
export function recall(kind: string, root: string): ResumableTask | undefined {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(keyOf(kind));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    forget(kind);
    return undefined;
  }

  // **必须先确认它是个对象。** `JSON.parse` 对合法的 `"null"`、`"42"`、
  // `'"字符串"'` 都会成功返回，直接往下读属性时 `null` 会当场抛
  // `Cannot read properties of null`——**一个用来兜脏数据的函数，
  // 自己被脏数据放倒了**。这条是写测试时才发现的。
  if (typeof parsed !== "object" || parsed === null) {
    forget(kind);
    return undefined;
  }

  const task = parsed as Partial<ResumableTask>;
  const usable =
    typeof task.taskId === "string" &&
    task.taskId.length > 0 &&
    typeof task.root === "string" &&
    typeof task.startedAt === "number" &&
    Number.isFinite(task.startedAt);

  if (!usable) {
    forget(kind);
    return undefined;
  }

  if (Date.now() - (task.startedAt as number) > MAX_AGE_MS) {
    forget(kind);
    return undefined;
  }

  if (task.root !== root) return undefined;

  return task as ResumableTask;
}
