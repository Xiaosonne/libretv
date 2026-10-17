import { cmsRequestHeaders, parseSearchList } from '@/lib/cms-parser';
import { fetchUpstream } from '@/lib/fetch-utils';
import { probeQuality } from '@/lib/quality-probe';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { blockHost, listDetections, upsertDetections, type SourceDetectionRow } from './db';

/**
 * 源检测流水线：可用性 → 病毒特征 → 画质，结果写入 SQLite 供全设备共享。
 *
 * - 可用性：与 /api/source/test 同口径（搜索 "test" 的响应耗时与结果量）；
 * - 病毒特征：采集站劫持/木马的典型表现是搜索接口返回 HTML 而非 JSON
 *   （杀软曾报 Trojan/HTML.Redirector.bz），据此标记可疑并自动拉黑域名；
 * - 画质：取搜索结果第一部影片走 probeQuality（m3u8/分片解析分辨率），
 *   "test" 无结果时跳过（不做猜测性搜索，避免误耗上游配额）。
 */

/** 单源检测超时（与画质探测死线同量级） */
const AVAILABILITY_TIMEOUT_MS = 6000;

/** JSON 响应不应以 '<' 开头：HTML/劫持页/错误页都命中这条 */
function looksLikeHtml(text: string): boolean {
  return text.trimStart().startsWith('<');
}

/** 检测单个源；网络异常不抛出，全部折叠进结果行 */
async function evaluateSource(rawUrl: string): Promise<Omit<SourceDetectionRow, 'checkedAt'>> {
  const url = rawUrl.trim().replace(/\/+$/, '');
  const base = { url, malware: 'unknown' as const };

  const verdict = await checkUpstreamAllowed(url);
  if (!verdict.ok) {
    return { ...base, ok: false, error: verdict.reason, malware: 'unknown' };
  }

  const start = Date.now();
  let body: string;
  try {
    const res = await fetchUpstream(`${url}?ac=videolist&wd=test`, {
      timeoutMs: AVAILABILITY_TIMEOUT_MS,
      headers: { ...cmsRequestHeaders(), Accept: 'application/json' },
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      return { ...base, ok: false, ms, error: `HTTP ${res.status}` };
    }
    body = await res.text();
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ...base,
      ok: false,
      ms: Date.now() - start,
      error: timedOut ? '超时' : err instanceof Error ? err.message : '请求失败',
    };
  }

  const ms = Date.now() - start;

  // 病毒特征：视频接口返回 HTML = 站点被劫持/挂马，标记可疑并拉黑域名
  if (looksLikeHtml(body)) {
    const reason = '视频接口返回 HTML 而非 JSON（疑似劫持/木马页）';
    try {
      blockHost(new URL(url).hostname, reason, 'auto');
    } catch {
      // 域名解析失败不影响检测结果本身
    }
    return { ...base, ok: false, ms, malware: 'suspicious', malwareReason: reason };
  }

  let list: ReturnType<typeof parseSearchList> = [];
  try {
    list = parseSearchList(JSON.parse(body), { key: 'inspect', name: 'inspect', url });
  } catch {
    return { ...base, ok: false, ms, error: '响应不是合法 JSON' };
  }

  // 画质：有结果才有探测对象；探测失败不回滚可用性结论
  let qualityHeight: number | undefined;
  if (list.length > 0 && /^[\w-]+$/.test(list[0].vodId)) {
    try {
      const r = await probeQuality({ source: { key: 'inspect', name: 'inspect', url }, id: list[0].vodId });
      if (r.height !== undefined) qualityHeight = r.height;
    } catch {
      // 画质探测失败仅表示「测不出」，不影响源判定
    }
  }

  return {
    ...base,
    ok: true,
    ms,
    resultCount: list.length,
    qualityHeight,
    malware: 'clean',
  };
}

/**
 * 检测单个源并落库。单源手动检测 / 批量任务 / 定时巡检统一走这里，
 * 保证任何路径的检测结果都进入 SQLite 供全设备共享。
 */
export async function inspectSource(rawUrl: string): Promise<Omit<SourceDetectionRow, 'checkedAt'>> {
  const row = await evaluateSource(rawUrl);
  upsertDetections([{ ...row, checkedAt: Date.now() }]);
  return row;
}

export interface InspectProgress {
  total: number;
  done: number;
  suspicious: number;
  ok: number;
}

export interface InspectJob {
  id: string;
  progress: InspectProgress;
  startedAt: number;
  finishedAt?: number;
}

const INSPECT_CONCURRENCY = 4;

// 后台检测任务表（内存即可：结果已落库，进程重启丢的只是进度显示）
const g = globalThis as typeof globalThis & { __libretvInspectJobs?: Map<string, InspectJob> };
function jobs(): Map<string, InspectJob> {
  g.__libretvInspectJobs ??= new Map();
  return g.__libretvInspectJobs;
}

/** 批量检测：并发受限、进度实时回写，调用方经 findInspectJob 轮询 */
export function startInspectJob(id: string, urls: string[]): InspectJob {
  const job: InspectJob = {
    id,
    progress: { total: urls.length, done: 0, ok: 0, suspicious: 0 },
    startedAt: Date.now(),
  };
  jobs().set(id, job);
  // 防积压：只保留最近 10 个任务记录
  while (jobs().size > 10) {
    const oldest = [...jobs().values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) jobs().delete(oldest.id);
  }

  void (async () => {
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= urls.length) return;
        try {
          const row = await inspectSource(urls[index]);
          if (row.ok) job.progress.ok++;
          if (row.malware === 'suspicious') job.progress.suspicious++;
        } catch {
          // inspectSource 内部已兜底，这里只是防御
        }
        job.progress.done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, urls.length) }, worker));
    job.finishedAt = Date.now();
  })();

  return job;
}

export function findInspectJob(id: string): InspectJob | undefined {
  return jobs().get(id);
}

/** 从库里取已登记过的源地址（定时巡检的候选集合） */
export function knownSourceUrls(): string[] {
  return Object.keys(listDetections());
}
