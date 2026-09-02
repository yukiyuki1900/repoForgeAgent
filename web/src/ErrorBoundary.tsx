import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 渲染期异常的兜底。
 *
 * 这一层**只能**用 class 组件——`getDerivedStateFromError` / `componentDidCatch`
 * 没有 hooks 等价物，这是 React 里为数不多必须写 class 的地方。
 *
 * 为什么非要有：这个界面渲染的是模型输出和仓库分析结果，两者都不是
 * 前端能完全预料形状的数据。一个没考虑到的 `undefined` 会让整页白屏，
 * 而白屏之后连「刚才发生了什么」都看不到——**报错信息本身就是产品的一部分**。
 *
 * 兜底之后仍然把 error 打到 console：这里显示的是给用户看的说明，
 * 排查要的是完整堆栈，两者不能互相替代。
 */

interface Props {
  children: ReactNode;
  /** 出错时的区域名，让用户知道是哪一块挂了而不是整个应用没了 */
  area?: string;
}

interface State {
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary] ${this.props.area ?? "app"} 渲染失败`, error, info);
  }

  private reset = (): void => {
    this.setState({ error: undefined });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section className="panel error-boundary">
        <div className="panel-head">
          <h2>{this.props.area ?? "这块内容"}没能显示出来</h2>
          <span className="panel-action">
            <button type="button" onClick={this.reset}>
              重新渲染
            </button>
          </span>
        </div>
        <div className="narration">
          <p className="locate-hint">
            页面的其它部分仍然可用。如果重新渲染还是失败，多半是这次返回的数据形状
            超出了预期——完整堆栈已经打在控制台。
          </p>
          <pre className="error-detail">{error.message}</pre>
        </div>
      </section>
    );
  }
}
