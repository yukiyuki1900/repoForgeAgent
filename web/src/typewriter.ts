import { useEffect, useRef, useState } from "react";

/**
 * 打字机：把到货的文本按帧吐出去。
 *
 * 「流式」和「看起来像流式」是两回事。服务端确实在逐段推，但中间隔着
 * TCP 缓冲合并、React 的 setState 批处理，再加上模型本身吐字就快——
 * 几百字一两秒到齐，直接渲染的结果就是「唰」地全出来。
 *
 * 所以节奏得由客户端自己排。收到的文本先进队列，再按帧取出——
 * 这也是其它 Agent 产品打字机效果的来源，它不是网络给的。
 */

/** 追赶时长（帧数）：无论落后多少字，都在这个帧数内追平 */
const CATCH_UP_FRAMES = 24;

/**
 * 这一帧该显示到第几个字。
 *
 * 步长跟落后量成正比，而不是固定值：固定每帧 2 字的话，
 * 两千字的回答要 16 秒才播完，人早就等烦了。按比例走，
 * 无论回答多长都在约 CATCH_UP_FRAMES 帧内追平——
 * 模型慢的时候逐字蹦，模型快的时候平滑跟进，始终差半拍。
 */
export function nextCount(current: number, total: number): number {
  if (current >= total) return total;
  const stride = Math.max(1, Math.ceil((total - current) / CATCH_UP_FRAMES));
  return Math.min(total, current + stride);
}

export interface Typewriter {
  /** 当前该显示的文本 */
  text: string;
  /** 是否已经追上源文本——追上之前不能当作「写完了」 */
  settled: boolean;
}

/**
 * @param source 累积的完整文本，可以持续变长
 * @param instant 跳过动画，直接显示全文（历史记录、重连补齐等场景）
 */
export function useTypewriter(source: string, instant = false): Typewriter {
  const [count, setCount] = useState(0);

  // 放进 ref，让 rAF 循环只建立一次：把 source 写进依赖会导致
  // 每来一个增量就重启一次循环，节奏被打断
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const countRef = useRef(0);

  useEffect(() => {
    if (instant) {
      countRef.current = sourceRef.current.length;
      setCount(countRef.current);
      return;
    }

    let frame = 0;
    const step = () => {
      const total = sourceRef.current.length;

      if (countRef.current !== total) {
        // 文本变短说明换了一轮回答，从头开始，否则会留着上一次的残影
        countRef.current = countRef.current > total ? 0 : nextCount(countRef.current, total);
        setCount(countRef.current);
      }

      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [instant]);

  const shown = Math.min(count, source.length);
  return { text: source.slice(0, shown), settled: shown >= source.length };
}
