/**
 * 把当前看的是哪个任务写进地址栏。
 *
 * ## 为什么非要进 URL
 *
 * `session.ts` 已经把 taskId 记在 `localStorage` 里了，刷新能接回来。
 * 但那份记录有三个改不掉的限制：**每种模式只留最近一条**、**任务结束
 * 就清掉**、**只在这台机器这个浏览器里有效**。
 *
 * URL 没有这些限制，而且它是唯一一样**用户能复制、能收藏、能发给别人**
 * 的东西。「我这边分析卡住了」后面能跟一条链接，和跟一句「你也跑一下」，
 * 是两种协作。
 *
 * 两者不是替代关系，职责是分开的：
 *
 * - `localStorage` —— **隐式恢复**：用户什么都没做，刷新后自动接回去
 * - URL           —— **显式寻址**：用户（或别人）明确指定要看哪一个
 *
 * 所以恢复时 URL 优先：**用户明说的，永远盖过我们替他记住的。**
 *
 * ## 为什么是 replaceState 而不是 pushState
 *
 * 写编号不是一次「导航」。用 `pushState` 的话，任务一开始就往历史栈里
 * 压一条，用户点后退期望回到上一个页面，实际只是把地址栏的编号退掉，
 * 界面一动不动——**后退键失灵是那种没人会报障、但每个人都觉得别扭的问题。**
 */

const TASK_PARAM = "task";
const MODE_PARAM = "mode";

export type TaskMode = "analyze" | "refactor" | "ask";

const MODES: readonly TaskMode[] = ["analyze", "refactor", "ask"];

function currentParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** 地址栏里指定的任务编号；没有就返回 undefined */
export function taskFromUrl(mode: TaskMode): string | undefined {
  const params = currentParams();
  const taskId = params.get(TASK_PARAM);
  if (!taskId) return undefined;

  // **编号必须和模式配对使用。** 只认编号的话，用户带着一个 ask 的链接
  // 切到分析面板，那个面板会去接一个问答任务，然后拿它的结果去渲染
  // 分析报告——**类型对不上的数据比没有数据更难排查**
  const declared = params.get(MODE_PARAM);
  if (declared && declared !== mode) return undefined;
  return taskId;
}

/** 地址栏里指定的模式，供页面决定默认打开哪个面板 */
export function modeFromUrl(): TaskMode | undefined {
  const declared = currentParams().get(MODE_PARAM);
  return MODES.includes(declared as TaskMode) ? (declared as TaskMode) : undefined;
}

/**
 * 把编号写进地址栏（传 undefined 则清掉）。
 *
 * 整个函数包在 try 里：`history` API 在 `file://`、沙箱 iframe、
 * 以及某些内嵌 WebView 里会直接抛 `SecurityError`。
 * **一个用来分享链接的便利功能，不该让主流程挂掉。**
 */
export function writeTaskToUrl(mode: TaskMode, taskId?: string): void {
  try {
    const params = currentParams();
    if (taskId) {
      params.set(TASK_PARAM, taskId);
      params.set(MODE_PARAM, mode);
    } else {
      params.delete(TASK_PARAM);
      params.delete(MODE_PARAM);
    }

    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  } catch {
    // 地址栏写不了就算了，功能本身照常
  }
}
