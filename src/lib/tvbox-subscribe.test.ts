import { describe, expect, it } from 'vitest';
import { extractSubscribeUrls, mergeSubscriptionPayloads, parseSubscriptionPayload } from './tvbox-parser';
import type { SourceListPayload } from './types';

/** 嵌套聚合订阅（subscribe/urls）提取与子配置合并的单测 */

describe('extractSubscribeUrls', () => {
  it('字符串数组形式的 subscribe', () => {
    expect(extractSubscribeUrls({ subscribe: ['https://a.example/1.json', 'https://b.example/2.json'] })).toEqual([
      'https://a.example/1.json',
      'https://b.example/2.json',
    ]);
  });

  it('对象形式 { url } 与混合数组', () => {
    expect(
      extractSubscribeUrls({
        subscription: [{ name: 'A', url: 'https://a.example/1.json' }, 'https://b.example/2.json', { noUrl: true }],
      })
    ).toEqual(['https://a.example/1.json', 'https://b.example/2.json']);
  });

  it('过滤非 http(s) 地址并去重', () => {
    expect(
      extractSubscribeUrls({
        urls: ['./local.json', 'https://a.example/1.json', 'https://a.example/1.json', 'ftp://x'],
      })
    ).toEqual(['https://a.example/1.json']);
  });

  it('优先级：subscribe > urls > subscription；无嵌套字段返回空', () => {
    expect(extractSubscribeUrls({ urls: ['https://u.example'], subscribe: ['https://s.example'] })).toEqual([
      'https://s.example',
    ]);
    expect(extractSubscribeUrls({ sites: [] })).toEqual([]);
    expect(extractSubscribeUrls(null)).toEqual([]);
    expect(extractSubscribeUrls('str')).toEqual([]);
  });
});

describe('mergeSubscriptionPayloads', () => {
  const payload = (over: Partial<SourceListPayload>): SourceListPayload => ({
    sources: [],
    liveSources: [],
    ...over,
  });

  it('按 URL 去重合并（先到先得），统计累加', () => {
    const merged = mergeSubscriptionPayloads(
      [
        payload({
          name: 'A',
          sources: [{ name: '源1', url: 'https://1.example/api' }],
          stats: { format: 'tvbox', skipped: 2, skippedByReason: { spider: 2 }, truncated: 0 },
        }),
        payload({
          sources: [
            { name: '源1重复', url: 'https://1.example/api' },
            { name: '源2', url: 'https://2.example/api' },
          ],
          liveSources: [{ name: '直播1', url: 'https://live.example/list.m3u' }],
          stats: { format: 'libretv', skipped: 1, skippedByReason: { xml: 1 }, truncated: 0 },
        }),
      ],
      '聚合订阅'
    );

    expect(merged.name).toBe('聚合订阅');
    expect(merged.sources).toEqual([
      { name: '源1', url: 'https://1.example/api' },
      { name: '源2', url: 'https://2.example/api' },
    ]);
    expect(merged.liveSources).toEqual([{ name: '直播1', url: 'https://live.example/list.m3u' }]);
    expect(merged.stats).toEqual({
      format: 'tvbox',
      skipped: 3,
      skippedByReason: { spider: 2, xml: 1 },
      truncated: 0,
    });
  });

  it('点播源超出上限时截断并计入统计', () => {
    // MAX_VOD_SOURCES = 100：两包各 55 个不重复的源，合计 110 截断到 100
    const pack = (offset: number) =>
      Array.from({ length: 55 }, (_, i) => ({ name: `源${offset + i}`, url: `https://s${offset + i}.example/api` }));
    const merged = mergeSubscriptionPayloads([payload({ sources: pack(0) }), payload({ sources: pack(55) })]);
    expect(merged.sources).toHaveLength(100);
    expect(merged.stats!.truncated).toBe(10);
  });

  it('空输入返回空聚合结果', () => {
    const merged = mergeSubscriptionPayloads([]);
    expect(merged.sources).toEqual([]);
    expect(merged.liveSources).toEqual([]);
    expect(merged.stats!.skipped).toBe(0);
  });
});

describe('聚合订阅整体链路（提取 → 子配置解析 → 合并）', () => {
  it('子配置为 TVBOX / LibreTV 混合格式时均可解析合并', () => {
    const subUrls = extractSubscribeUrls({ subscribe: ['https://a.example/tvbox.json', 'https://b.example/list.json'] });
    expect(subUrls).toHaveLength(2);

    const tvboxChild = parseSubscriptionPayload({
      sites: [{ name: '直连源', type: 1, api: 'https://vod.example/api.php/provide/vod' }],
      lives: [],
    });
    const libretvChild = parseSubscriptionPayload({
      sources: [{ name: '列表源', url: 'https://cms.example/api.php/provide/vod' }],
    });

    const merged = mergeSubscriptionPayloads([tvboxChild, libretvChild]);
    expect(merged.sources.map((s) => s.url)).toEqual([
      'https://vod.example/api.php/provide/vod',
      'https://cms.example/api.php/provide/vod',
    ]);
  });
});
