import { useState } from "react";
import { ActivityLog } from "./ActivityLog";
import { describeError, runTask, type TaskEvent } from "./task";

/**
 * 改造面板。
 *
 * 这是整个界面上**唯一会修改用户代码**的地方，所以交互被刻意做成两步：
 * 先生成计划看清楚要改哪几行，再显式点「应用」。
 *
 * 按钮上不写「一键修复」这类说法——它会让人以为可以不看就点。
 * 应用按钮只有在计划里真的存在可拆边时才出现，且始终附带
 * 「会写入磁盘」的字样。后端那边 `apply` 默认 false，
 * 少传一个参数的后果是什么都不发生，而不是代码被改了。
 */

interface ImportEdit {
  file: string;
  line: number;
  specifier: string;
  names: string[];
  reason?: string;
}

interface CyclePlan {
  files: string[];
  loop?: string;
  candidates: ImportEdit[];
  blocked: Array<ImportEdit & { reason: string }>;
  breakable: boolean;
}

interface RefactorPlan {
  cyclesBefore: number;
  cyclesAfter: number;
  cycles: CyclePlan[];
  filesAffected: number;
  blockers: string[];
}

interface RefactorResult {
  applied: boolean;
  plan: RefactorPlan | null;
  text: string;
  outcome?: {
    status: "applied" | "rolled-back" | "aborted" | "no-op";
    edits: ImportEdit[];
    skipped: Array<ImportEdit & { reason: string }>;
    typecheck?: { baselineErrors: number; afterErrors: number; introduced: unknown[] };
    cycles?: { before: number; predicted: number; actual: number };
    reason?: string;
    outputDir?: string;
    diff?: string;
  };
}

const STATUS_LABEL: Record<string, string> = {
  applied: "改造已应用",
  "rolled-back": "验证未通过，改动已还原",
  aborted: "已放弃，未写入任何文件",
  "no-op": "没有可改的边",
};

export function RefactorPanel({ root }: { root: string }) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [result, setResult] = useState<RefactorResult | undefined>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [finishedAt, setFinishedAt] = useState<number>();

  const run = async (apply: boolean) => {
    setBusy(true);
    setConfirming(false);
    setEvents([]);
    if (apply) setResult(undefined);
    setNotice("");
    setStartedAt(Date.now());
    setFinishedAt(undefined);

    try {
      const status = await runTask<RefactorResult>("/refactor", { root, apply }, (event) =>
        setEvents((previous) => [...previous, event]),
      );

      if (status.status === "failed") {
        setNotice(`执行失败：${status.error ?? "未知错误"}`);
        return;
      }
      setResult(status.result);
      setNotice(
        status.result?.applied
          ? (STATUS_LABEL[status.result.outcome?.status ?? ""] ?? "已执行")
          : "计划已生成，未写入任何文件",
      );
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setFinishedAt(Date.now());
      setBusy(false);
    }
  };

  const plan = result?.plan;
  const candidates = plan?.cycles.flatMap((cycle) => cycle.candidates) ?? [];
  const canApply = !result?.applied && candidates.length > 0;

  return (
    <>
      <section className="control-panel mode-actions">
        <div className="mode-intro">
          <strong>
            用 <code>import type</code> 打破循环依赖
          </strong>
          <p>
            只改「仅用于类型」的导入——语义等价的机械变换。判定从严：只要有一处引用落在值位置就不改。
          </p>
        </div>
        <div className="mode-buttons">
          <button className="primary-button" onClick={() => run(false)} disabled={busy}>
            {busy ? "执行中…" : "生成改造计划"}
          </button>
        </div>
      </section>

      {notice && <div className="notice">{notice}</div>}

      {startedAt !== undefined && (
        <ActivityLog
          events={events}
          running={busy}
          startedAt={startedAt}
          finishedAt={finishedAt}
          label="执行"
        />
      )}

      {plan && (
        <section className="panel">
          <div className="panel-head">
            <h2>改造计划</h2>
            <span className="panel-action">
              {plan.cyclesBefore} 个环 → {plan.cyclesAfter} 个环
            </span>
          </div>
          <div className="refactor-body">
            {plan.blockers.map((blocker) => (
              <div key={blocker} className="notice demo">
                ⚠ {blocker}
              </div>
            ))}

            {plan.cycles.map((cycle, index) => (
              <div key={index} className="cycle-card">
                <div className="cycle-head">
                  <strong>环 #{index + 1}</strong>
                  <code>{cycle.loop ?? cycle.files.join(" → ")}</code>
                </div>

                {cycle.candidates.map((item) => (
                  <div key={`${item.file}:${item.line}`} className="edit-row ok">
                    <span className="edit-mark">✓ 可拆</span>
                    <code>
                      {item.file}:{item.line}
                    </code>
                    <span className="edit-detail">
                      import {"{"} {item.names.join(", ")} {"}"} from &quot;{item.specifier}&quot;
                    </span>
                  </div>
                ))}

                {cycle.blocked.map((item) => (
                  <div key={`${item.file}:${item.line}`} className="edit-row blocked">
                    <span className="edit-mark">✗ 不可拆</span>
                    <code>
                      {item.file}:{item.line}
                    </code>
                    <span className="edit-detail">{item.reason}</span>
                  </div>
                ))}

                <div className="cycle-verdict">
                  {cycle.candidates.length === 0
                    ? "无可拆边，需要结构性重构"
                    : cycle.breakable
                      ? `改 ${cycle.candidates.length} 条边即可打破此环`
                      : `改 ${cycle.candidates.length} 条边仍无法打破此环`}
                </div>
              </div>
            ))}

            {canApply && (
              <div className="apply-zone">
                {confirming ? (
                  <>
                    <p className="apply-warning">
                      将修改 <b>{plan.filesAffected}</b> 个文件、
                      <b>{candidates.length}</b> 条 import，<b>直接写入磁盘</b>。
                      写入前会检查目标文件已被 git
                      跟踪且无未提交改动；写入后做类型检查与环数对账，任一不符自动回滚。
                    </p>
                    <div className="apply-actions">
                      <button onClick={() => setConfirming(false)}>取消</button>
                      <button className="primary-button danger" onClick={() => run(true)}>
                        确认写入
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    className="primary-button"
                    onClick={() => setConfirming(true)}
                    disabled={busy}
                  >
                    应用改造（会写入磁盘）→
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {result?.outcome && (
        <section className="panel">
          <div className="panel-head">
            <h2>验证结果</h2>
            <span className={`panel-action ${result.outcome.status}`}>
              {STATUS_LABEL[result.outcome.status]}
            </span>
          </div>
          <div className="refactor-body">
            {result.outcome.reason && <div className="notice">{result.outcome.reason}</div>}

            <div className="verify-grid">
              {result.outcome.typecheck && (
                <div className="verify-item">
                  <span>类型检查</span>
                  <strong>
                    基线 {result.outcome.typecheck.baselineErrors} → 改后{" "}
                    {result.outcome.typecheck.afterErrors}
                  </strong>
                  <small>新增 {result.outcome.typecheck.introduced.length} 条</small>
                </div>
              )}
              {result.outcome.cycles && (
                <div className="verify-item">
                  <span>循环依赖</span>
                  <strong>
                    {result.outcome.cycles.before} → {result.outcome.cycles.actual}
                  </strong>
                  <small>
                    预测 {result.outcome.cycles.predicted}·
                    {result.outcome.cycles.actual === result.outcome.cycles.predicted
                      ? "一致"
                      : "不一致"}
                  </small>
                </div>
              )}
            </div>

            {result.outcome.skipped.length > 0 && (
              <div className="skipped-list">
                <span className="locate-hint">以下边判定可拆但未写入，需人工处理：</span>
                {result.outcome.skipped.map((item) => (
                  <div key={`${item.file}:${item.line}`} className="edit-row blocked">
                    <code>
                      {item.file}:{item.line}
                    </code>
                    <span className="edit-detail">{item.reason}</span>
                  </div>
                ))}
              </div>
            )}

            {result.outcome.diff && (
              <details className="diff-block" open>
                <summary>改动 diff</summary>
                <pre>{result.outcome.diff}</pre>
              </details>
            )}

            {result.outcome.outputDir && (
              <p className="locate-hint">产物：{result.outcome.outputDir}</p>
            )}
          </div>
        </section>
      )}

      {result && !plan && <div className="notice">{result.text}</div>}
    </>
  );
}
