/**
 * 景点配图代理 · `GET /api/image?q=浅草寺&w=360`
 *
 * 为什么不在前端直接引用图床：
 *  1) Wikimedia 的域名（upload/thumb.wikimedia.org）在**境内访问很不稳定**，
 *     走自己的域名代理能把图片和页面一起送达；
 *  2) 多源解析与缓存放在服务端，换图源时前端一行都不用改；
 *  3) 图源将来若换成需要 Key 的服务，Key 也不会进前端产物。
 *
 * 三级回退（命中即返回，逐级降级）：
 *  A) zh.wikipedia 条目主图（pageimages）—— 最准，但小景点常没有；
 *  B) Wikidata 实体 P18 属性 —— 跨语言命中率高，是标准照片；
 *  C) Commons 文件搜索（限定 bitmap）—— 兜底，偶尔会搜到非景点图，可接受。
 *
 * 全部拿不到时返回 404，前端渲染占位块，不留白框。
 */

type VercelRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
  end(): void;
};

const UA = 'TravelPlannerDemo/1.0 (https://lanai.icu; contact: demo@lanai.icu)';
const TIMEOUT_MS = 6000;
/** 命中缓存 12 小时；未命中的负结果只缓存 10 分钟（防抖一次网络失误把图永久判死） */
const HIT_TTL = 12 * 3600 * 1000;
const MISS_TTL = 10 * 60 * 1000;
const cache = new Map<string, { url: string | null; exp: number }>();

function firstParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

async function getJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 只要位图，SVG/PDF/DJVU 一律丢掉（常见于 Logo 与古籍扫描件） */
function isUsableImage(mime: string | undefined, url: string): boolean {
  if (mime && !/^image\/(jpeg|png|webp)$/.test(mime)) return false;
  return !/\.svg($|\?)|\.pdf($|\?)|\.djvu($|\?)/i.test(url);
}

/**
 * A) Wikipedia REST 摘要：**一次请求**就带缩略图，是最快的一路。
 * `originalimage` 兜底可能拿到超大原图，优先用 `thumbnail`。
 */
async function viaRestSummary(name: string): Promise<string | null> {
  const data = await getJson(
    `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`,
  );
  const src: string | undefined = data?.thumbnail?.source ?? data?.originalimage?.source;
  if (src && isUsableImage(undefined, src)) return src;
  return null;
}

/** B) Wikidata 实体 P18（跨语言命中率高，是不带 Logo 的标准照片） */
async function viaWikidata(name: string): Promise<string | null> {
  const search = await getJson(
    'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=zh&uselang=zh&limit=1&search=' +
      encodeURIComponent(name),
  );
  const qid: string | undefined = search?.search?.[0]?.id;
  if (!qid) return null;

  const claims = await getJson(
    `https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&property=P18&entity=${qid}`,
  );
  const file: string | undefined = claims?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (!file || !isUsableImage(undefined, file)) return null;

  // 换成 Commons 的直链缩略图，而不是 Special:FilePath —— 后者要多一跳 302，
  // 实测偶发 502（大皇宫那张就挂在重定向上）。
  const info = await getJson(
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo' +
      '&iiprop=url|mime&iiurlwidth=400&titles=' +
      encodeURIComponent(`File:${file}`),
  );
  const page = Object.values((info?.query?.pages ?? {}) as Record<string, any>)[0];
  const thumb: string | undefined = page?.imageinfo?.[0]?.thumburl;
  if (thumb && isUsableImage(page?.imageinfo?.[0]?.mime, thumb)) return thumb;
  return null;
}

/** C) Commons 文件搜索兜底 */
async function viaCommonsSearch(name: string, width: number): Promise<string | null> {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    '&generator=search&gsrnamespace=6&gsrlimit=8' +
    '&gsrsearch=' +
    encodeURIComponent(`${name} filetype:bitmap`) +
    '&prop=imageinfo&iiprop=url|mime&iiurlwidth=' +
    width;
  const data = await getJson(url);
  const pages = (data?.query?.pages ?? {}) as Record<string, any>;
  for (const p of Object.values(pages)) {
    const info = (p?.imageinfo ?? [])[0];
    const src: string | undefined = info?.thumburl;
    if (src && isUsableImage(info?.mime, src)) return src;
  }
  return null;
}

async function resolveImage(
  name: string,
  width: number,
  retry = false,
): Promise<string | null> {
  // 带 retry 的请求走独立缓存键：绕过上一次的「无图」负缓存，
  // 否则某次网络抖动会让这个景点在接下来 10 分钟里一直是占位块。
  const key = `${name}|${width}|${retry ? 'r' : ''}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;

  /**
   * 三路**完全并行**再按优先级取第一个命中的结果。
   *
   * 串行时最坏耗时要相加（实测洱海 9.8s、石林 9.9s），并行后约等于最慢的**单路**。
   * 代价是没图的景点会多打一次 Commons 请求 —— 相比让用户盯着空框，这点成本值得。
   */
  const [rest, wikidata, commons] = await Promise.all([
    viaRestSummary(name),
    viaWikidata(name),
    viaCommonsSearch(name, width),
  ]);
  const found = rest ?? wikidata ?? commons;

  cache.set(key, { url: found, exp: Date.now() + (found ? HIT_TTL : MISS_TTL) });
  return found;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'only GET' }));
    return;
  }

  const name = firstParam(req.query.q).trim().slice(0, 40);
  const width = Math.min(800, Math.max(120, Number(firstParam(req.query.w)) || 360));
  const retry = firstParam(req.query.r) === '1';
  if (!name) {
    res.status(400).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'missing q' }));
    return;
  }

  const src = await resolveImage(name, width, retry);
  if (!src) {
    // 短缓存：避免反复重试把上游打爆，但过一阵又能重新解析
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'no image', q: name }));
    return;
  }

  // 把图取回来再转发：前端始终只和本站通信
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(src, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      res.status(502).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'upstream fetch failed', status: upstream.status }));
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    // 图片基本不变，长缓存；再配合 CDN 边缘缓存
    res.setHeader('Cache-Control', 'public, max-age=2592000, s-maxage=31536000, immutable');
    res.send(buf);
  } catch (err) {
    res.status(502).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: String(err) }));
  } finally {
    clearTimeout(timer);
  }
}
