/**
 * 景点配图地址。
 *
 * 只做「拼 URL」，不在这里发请求：行程子链是纯计算节点，塞网络调用会让
 * 三链并行退化成串行等待（十几张图 × 每次几百毫秒）。真正的解析与
 * 转发交给 `/api/image`，浏览器按需懒加载即可。
 */

/** 默认缩略图宽度：够卡片显示，又不至于拖慢首屏 */
const DEFAULT_WIDTH = 360;

/**
 * 把「活动名」清洗成「地名」再拿去搜图。
 *
 * LLM 排出来的活动名常常带动作词——「洱海环湖骑行」「大理古城游览」
 * 「丽江古城自由活动」。整串丢给图源基本搜不到，必须剥掉动词与括注。
 */
/**
 * 这些不是「地名」，拿去搜图只会得到随机风景照，宁可不配图。
 * 清洗后落在这些词上的，直接返回空串（调用方当作无图处理）。
 */
const GENERIC_NAMES =
  /^(自由活动|休息|用餐|早餐|午餐|晚餐|入住|退房|返程|出发|抵达|城市漫步|购物|休闲|酒店|住宿|集合|解散)$/;

function cleanAttractionName(name: string): string {
  let s = (name ?? '').trim();
  // LLM 常用「A/B」表示并列活动，取第一个就够了（配图只需要一个主体）
  s = s.split(/[/｜|]/)[0]!.trim();
  s = s.replace(/^(前往|去往|去|抵达|游览|参观)/, '');
  // ⚠️ 必须**先**去括注再去动词：`洱海环湖骑行（才村-喜洲段）` 如果先剥后缀，
  // 结尾是 `）` 匹配不上，动词留着就会搜不到图。
  s = s.replace(/[（(][^）)]*[）)]/g, '').trim();
  s = s.replace(
    /(环湖|环岛|环城)?(骑行|徒步|漫步|游览|游玩|观光|参观|打卡|夜游|自由活动|泛舟|游船|乘船|漂流|登山|看日出|看日落)$/,
    '',
  );
  return s || (name ?? '').trim();
}

/** 返回配图地址；通用活动（自由活动/用餐/休息…）返回空串，表示不该有图 */
export function attractionImagePath(name: string, width = DEFAULT_WIDTH): string {
  const cleaned = cleanAttractionName(name);
  if (!cleaned || GENERIC_NAMES.test(cleaned)) return '';
  return `/api/image?q=${encodeURIComponent(cleaned)}&w=${width}`;
}
