import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { findInspectJob, inspectSource, startInspectJob } from '@/lib/server/source-inspector';
import {
  blockHost,
  listBlockedHosts,
  listDetections,
  unblockHost,
} from '@/lib/server/db';

export const runtime = 'nodejs';

/**
 * 云端源检测中心：
 * - GET            查询全部检测结果 + 黑名单（+ ?job= 查询检测进度）；
 * - POST { urls }  对指定源列表触发一轮检测（后台异步执行，返回 jobId 供轮询）；
 * - PUT { action } 黑名单手动维护：block { host, reason } / unblock { host }。
 */

/** 后台检测任务（内存）：POST 立即返回 jobId，避免长请求超时 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { urls?: unknown };
  try {
    body = (await req.json()) as { urls?: unknown };
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const urls = (Array.isArray(body.urls) ? body.urls : [])
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
    .slice(0, 200)
    .map((u) => u.trim().replace(/\/+$/, ''));
  const unique = [...new Set(urls)];
  if (unique.length === 0) {
    return NextResponse.json({ error: '没有可检测的源地址' }, { status: 400 });
  }

  // 单源模式： urls 只有 1 条时同步返回结果（单源手动刷新需要即时反馈）
  if (unique.length === 1) {
    const row = await inspectSource(unique[0]);
    return NextResponse.json({ single: row });
  }

  const jobId = `ins_${Date.now().toString(36)}`;
  const job = startInspectJob(jobId, unique);
  return NextResponse.json({ jobId, total: job.progress.total });
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const jobId = new URL(req.url).searchParams.get('job');
  if (jobId) {
    const job = findInspectJob(jobId);
    return NextResponse.json({ job: job ?? null });
  }
  return NextResponse.json({ detections: listDetections(), blocked: listBlockedHosts() });
}

export async function PUT(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { action?: string; host?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const host = (body.host || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return NextResponse.json({ error: '无效的域名' }, { status: 400 });
  }

  if (body.action === 'block') {
    blockHost(host, (body.reason || '手动拉黑').slice(0, 200), 'manual');
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'unblock') {
    return NextResponse.json({ ok: unblockHost(host) });
  }
  return NextResponse.json({ error: '未知操作' }, { status: 400 });
}
