/* EmotionBall 引擎的 TypeScript 声明 —— 引擎为经典脚本（无 ESM），挂 window.EmotionBall */
/* eslint-disable @typescript-eslint/no-explicit-any */

interface EmotionBallCreateOptions {
  /** 初始表情 ID（字符串，如 '02'） */
  emotion?: string;
  /** 身体形态：blob 圆胖 / wedge 三角 / gem 菱形 */
  shape?: "blob" | "wedge" | "gem";
  /** 主题色实例：{ body, eyes }，覆盖表情默认配色 */
  theme?: { body: string; eyes: string };
  /** 主题色 / 眼色（简易覆盖） */
  color?: string;
  eyeColor?: string;
  /** 待机策略：false 关闭 / true 默认 / 对象自定义 */
  idle?: boolean | { standbyAfter?: number; sleepAfter?: number } | null;
  /** 小于 80px 实例建议 1.5~1.8 保证可读 */
  eyeScale?: number;
  /** 标签：SVG id 前缀，同页多实例需区分 */
  label?: string;
  autostart?: boolean;
  lite?: boolean;
  /** 未知表情 ID 的回退 */
  fallbackId?: string;
  tipEl?: HTMLElement | null;
}

interface EmotionDef {
  id: string;
  name: string;
  group: string;
  base?: any;
  config?: any;
  blinkMs?: [number, number];
  gaze?: boolean;
}

interface EmotionBallInstance {
  emotionId: string;
  setEmotion(id: string, opts?: { auto?: boolean }): boolean;
  /** AI 对接：接受对象或 JSON 字符串 { emotionId, tips } */
  handleAIMessage(msg: Record<string, unknown> | string): boolean;
  on(evt: "change" | "tips" | "error", cb: (e: any) => void): void;
  off(evt: "change" | "tips" | "error", cb: (e: any) => void): void;
  /** 注视目标：-1 ~ 1，内部指数平滑 */
  setGaze(nx: number, ny: number): this;
  clearGaze(): this;
  setStyle(style: Record<string, unknown>): this;
  /** 自旋甩彩带（点击交互） */
  spin(turns?: number, dir?: number): this;
  /** 一次性物理粒子撒花 */
  burst(count?: number): this;
  bounce(): this;
  setActive(active: boolean): void;
  startTour(ids: string[], interval?: number): void;
  stopTour(): void;
  registerEmotion(config: Record<string, unknown>): boolean;
  destroy(): void;
}

interface EmotionBallNamespace {
  version?: string;
  create(el: HTMLElement, opts?: EmotionBallCreateOptions): EmotionBallInstance;
  config: {
    get(id: string): EmotionDef | undefined;
    list(): EmotionDef[];
    exportConfig(): Record<string, unknown>;
    importConfig(json: Record<string, unknown>): void;
  };
}

declare global {
  interface Window {
    EmotionBall?: EmotionBallNamespace;
  }
  const EmotionBall: EmotionBallNamespace | undefined;
}

export type {
  EmotionBallCreateOptions,
  EmotionBallInstance,
  EmotionBallNamespace,
  EmotionDef,
};
