import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';

export const runtime = 'nodejs';

/**
 * 豆瓣条目详情：爬 subject 页面提取简介/年份/地区/类型/演职员，供「我的片单」详情弹窗使用。
 * 片单条目本身只有标题/封面/评分，点开详情时按需补全；失败时前端降级展示基本信息。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const CACHE_TTL = 24 * 60 * 60 * 1000;

export interface DoubanDetail {
  id: string;
  title: string;
  year?: string;
  region?: string;
  genres?: string[];
  directors?: string[];
  actors?: string[];
  rating?: string;
  summary?: string;
  cover?: string;
}

/** 豆瓣页面是 UTF-8 编码的 HTML，实体只做常见命名实体与十进制实体的还原 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function firstMatch(html: string, re: RegExp): string | undefined {
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() || undefined : undefined;
}

function allMatches(html: string, re: RegExp, limit = 8): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    const v = decodeEntities(m[1]).trim();
    if (v) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const id = new URL(req.url).searchParams.get('id') || '';
  if (!/^\d{1,10}$/.test(id)) {
    return NextResponse.json({ error: '无效的豆瓣条目 id' }, { status: 400 });
  }

  const cacheKey = `douban-detail:${id}`;
  const cached = getCache<DoubanDetail>(cacheKey);
  if (cached) return NextResponse.json(cached);

  const target = `https://movie.douban.com/subject/${id}/`;
  // 目标域名固定为豆瓣，SSRF 校验防御未来该值被配置化后的风险
  const verdict = await checkUpstreamAllowed(target);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }

  let html: string;
  try {
    const res = await fetchUpstream(target, {
      timeoutMs: 8000,
      headers: { 'User-Agent': UA, Referer: 'https://movie.douban.com/', Accept: 'text/html' },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `豆瓣返回 HTTP ${res.status}` }, { status: 502 });
    }
    html = await res.text();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '豆瓣详情获取失败' },
      { status: 502 }
    );
  }

  const detail: DoubanDetail = {
    id,
    title: firstMatch(html, /<h1>\s*<span[^>]*>([^<]+)<\/span>/) ?? '',
    year: firstMatch(html, /class="year"[^>]*>\s*(\d{4})/),
    region: firstMatch(html, /制片国家\/地区:<\/span>([^<]+)/),
    genres: allMatches(html, /property="v:genre">([^<]+)</g, 5),
    directors: allMatches(html, /rel="v:directedBy"[^>]*>([^<]+)</g, 4),
    actors: allMatches(html, /rel="v:starring"[^>]*>([^<]+)</g, 6),
    rating: firstMatch(html, /class="ll rating_num"[^>]*>([\d.]+)</),
    summary: firstMatch(html, /property="v:summary"[^>]*>([\s\S]*?)<\/span>/)?.replace(/\s+/g, ' '),
    cover: firstMatch(html, /<img[^>]*rel="v:image"[^>]*src="([^"]+)"/) ?? firstMatch(html, /<img[^>]*src="([^"]+)"[^>]*rel="v:image"/),
  };

  if (!detail.title) {
    return NextResponse.json({ error: '豆瓣页面解析失败（可能被反爬拦截）' }, { status: 502 });
  }

  setCache(cacheKey, detail, CACHE_TTL);
  return NextResponse.json(detail);
}
