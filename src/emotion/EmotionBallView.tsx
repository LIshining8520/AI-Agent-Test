import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  EmotionBallCreateOptions,
  EmotionBallInstance,
} from "./emotionball.d";
import { EMOJI_NAME } from "./agentEmotion";

interface Props {
  /** 当前表情 ID（外部状态驱动） */
  emotion: string;
  /** 气泡文案；变化时显示 ~3.2s 后自动收起 */
  tips?: string | null;
  /** 完成类表情触发撒花/彩带 */
  celebrateOn?: string[];
  size?: number;
  style?: CSSProperties;
  /** 引擎实例就绪后回调（命令式驱动用） */
  onEngineReady?: (ball: EmotionBallInstance) => void;
  onEngineDestroy?: () => void;
  /** 眼球是否跟随鼠标（默认开） */
  followCursor?: boolean;
  /** 注视满偏距离（px）：光标离球心多远达到最大偏转，越大越含蓄 */
  gazeRadius?: number;
}

const DEFAULT_THEME = { body: "#8a63f4", eyes: "#1d1730" };

export default function EmotionBallView({
  emotion,
  tips,
  celebrateOn = ["33"],
  size = 150,
  style,
  onEngineReady,
  onEngineDestroy,
  followCursor = true,
  gazeRadius = 420,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<EmotionBallInstance | null>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const timerRef = useRef<number | null>(null);
  const readyCbRef = useRef(onEngineReady);
  readyCbRef.current = onEngineReady;
  const destroyCbRef = useRef(onEngineDestroy);
  destroyCbRef.current = onEngineDestroy;

  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  /* 创建引擎实例 */
  useEffect(() => {
    const el = mountRef.current;
    const NS = window.EmotionBall;
    if (!el || !NS) {
      setBroken(true);
      return;
    }
    const opts: EmotionBallCreateOptions = {
      emotion: "02",
      shape: "blob",
      theme: DEFAULT_THEME,
      idle: false,
      autostart: true,
      eyeScale: 1.6,
      label: `eb-${uid}`,
    };
    try {
      const ball = NS.create(el, opts);
      ballRef.current = ball;
      readyCbRef.current?.(ball);
    } catch (e) {
      console.error("[EmotionBall] 创建失败:", e);
      setBroken(true);
      return;
    }
    return () => {
      try {
        ballRef.current?.destroy();
      } catch {
        /* noop */
      }
      ballRef.current = null;
      destroyCbRef.current?.();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* emotion 变化 → 切表情；完成类表情附加庆祝特效 */
  const prevCelebration = useRef<string | null>(null);
  useEffect(() => {
    const ball = ballRef.current;
    if (!ball || !emotion) return;
    ball.setEmotion(emotion);
    if (celebrateOn.includes(emotion) && prevCelebration.current !== emotion) {
      prevCelebration.current = emotion;
      try {
        ball.spin(1);
        window.setTimeout(() => ball.burst(28), 260);
      } catch {
        /* noop */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emotion]);

  /* tips → 气泡，3.2s 自动收起 */
  useEffect(() => {
    if (tips == null) return;
    setBubble(tips);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setBubble(null), 3200);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [tips]);

  /* 鼠标跟随：把「球心 → 光标」的方向向量归一后交给引擎 setGaze。
   *
   * 引擎侧已经做了两件重活，这里不要重复实现：
   *  - 帧率无关的指数平滑（60fps 下每帧收敛约 9%），所以这里只管喂**目标方向**；
   *  - `-1 ~ 1` 归一化后乘 24 / 15 像素的球面位移，并做轮廓钳制。
   *
   * 本层的三个取舍：
   *  1) 用 rAF 合帧：pointermove 每秒能来几百次，直接调 setGaze 是白烧 CPU；
   *  2) 触屏不跟随：手指按在屏上时眼球黏在指尖反而怪；
   *  3) 尊重 prefers-reduced-motion：全局跟随对前庭敏感用户不友好，系统关了就别开。
   */
  useEffect(() => {
    if (!followCursor) return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    let raf = 0;
    let target: { x: number; y: number } | null = null;

    const flush = () => {
      raf = 0;
      const ball = ballRef.current;
      if (!ball || !target) return;
      ball.setGaze(target.x, target.y);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = mountRef.current;
      if (!el || !ballRef.current) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy);
      // 光标正好压在球心：方向无意义，保持当前注视
      if (dist < 1) return;
      // 方向归一 × 距离衰减：近处偏转小（含蓄），超过 gazeRadius 才吃满
      const gain = Math.min(1, dist / Math.max(gazeRadius, 1)) / dist;
      target = { x: dx * gain, y: dy * gain };
      if (!raf) raf = window.requestAnimationFrame(flush);
    };

    // 光标离开文档 / 窗口失焦：视线回正，避免眼球僵在最后一帧
    const reset = () => {
      target = null;
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      ballRef.current?.clearGaze();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [followCursor, gazeRadius]);

  if (broken) {
    return (
      <div style={{ ...styles.box, ...style }}>
        <span style={{ fontSize: size * 0.7 }}>😶</span>
      </div>
    );
  }

  return (
    <div
      style={{
        ...styles.box,
        width: size,
        height: size,
        ...style,
      }}
    >
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      {bubble ? (
        <div style={styles.bubble}>{bubble}</div>
      ) : (
        <div style={styles.name}>{EMOJI_NAME[emotion] ?? emotion}</div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  box: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    userSelect: "none",
  },
  bubble: {
    position: "absolute",
    top: -8,
    left: "50%",
    transform: "translate(-50%, -100%)",
    maxWidth: 220,
    padding: "6px 10px",
    borderRadius: 10,
    background: "var(--accent-bg, rgba(0,0,0,.85))",
    color: "var(--accent, #fff)",
    fontSize: 12,
    lineHeight: 1.4,
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    boxShadow: "0 4px 14px rgba(0,0,0,.18)",
    pointerEvents: "none",
  },
  name: {
    position: "absolute",
    bottom: -4,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 10,
    color: "var(--text-h, #666)",
    opacity: 0.55,
    whiteSpace: "nowrap",
  },
};
