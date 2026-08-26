import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextCount } from "../src/typewriter";

/**
 * 打字机的节奏。
 *
 * rAF 循环在 Node 里跑不了，但决定手感的其实是步长函数——
 * 它算错的表现是「两千字的回答播十几秒」或者「一帧就刷完」，
 * 两种都看不出是流式。
 */

/** 模拟一路播到底，返回用掉的帧数 */
function framesToFinish(total: number): number {
  let count = 0;
  let frames = 0;
  while (count < total) {
    count = nextCount(count, total);
    frames += 1;
    if (frames > 10_000) throw new Error("步长函数不收敛");
  }
  return frames;
}

describe("打字机步长", () => {
  it("每帧只前进一小步，不会一次刷完", () => {
    // 一帧吐完就没有流式可言了
    assert.equal(nextCount(0, 5), 1);
    assert.ok(nextCount(0, 240) < 240);
  });

  it("播放时长随文本长度对数增长，不是线性", () => {
    // 线性的话两千字要十几秒。步长按落后量成比例，
    // 于是长度翻十倍，帧数只多一点
    const short = framesToFinish(400);
    const long = framesToFinish(4000);
    const huge = framesToFinish(40_000);

    assert.ok(long < short * 2, `${short} → ${long} 增长过快`);
    assert.ok(huge < long * 2, `${long} → ${huge} 增长过快`);
    // 60fps 下 4000 字应当在数秒内播完
    assert.ok(long < 240, `4000 字用了 ${long} 帧`);
  });

  it("永远前进，不会卡住", () => {
    assert.equal(nextCount(9, 10), 10);
    // 落后 1 个字时步长仍为 1，而不是被 ceil 抹成 0
    assert.ok(nextCount(100, 101) > 100);
  });

  it("不会越过总长", () => {
    assert.equal(nextCount(5, 5), 5);
    assert.equal(nextCount(7, 5), 5, "已超出时夹回总长");

    let count = 0;
    for (let i = 0; i < 200; i += 1) count = nextCount(count, 37);
    assert.equal(count, 37);
  });

  it("落后越多走得越快", () => {
    assert.ok(nextCount(0, 2400) > nextCount(0, 24) * 10);
  });
});
