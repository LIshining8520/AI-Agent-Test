/**
 * 景点配图地址。
 *
 * 只做「拼 URL」，不在这里发请求：行程子链是纯计算节点，塞网络调用会让
 * 三链并行退化成串行等待（十几张图 × 每次几百毫秒）。真正的解析与
 * 转发交给 `/api/image`，浏览器按需懒加载即可。
 */

/** 默认缩略图宽度：够卡片显示，又不至于拖慢首屏 */
const DEFAULT_WIDTH = 360;

export function attractionImagePath(name: string, width = DEFAULT_WIDTH): string {
  const q = encodeURIComponent((name ?? '').trim());
  return `/api/image?q=${q}&w=${width}`;
}
