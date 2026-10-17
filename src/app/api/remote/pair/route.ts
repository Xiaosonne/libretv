import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { createPair, isValidPair, REMOTE_CAPABILITIES, subscribePair, unsubscribePair } from '@/lib/server/remote-pairing';

export const runtime = 'nodejs';

/**
 * 遥控配对端点：
 * - POST            TV 端生成配对码（需登录，防未登录者批量刷码），返回 {pair, capabilities}；
 * - GET ?pair=xxx   手机端拉取能力面板描述（{valid, capabilities}），扫码后渲染用；
 * - GET ?pair=xxx&mode=sse
 *                   TV 端 EventSource 订阅事件流（手机端能力调用的接收侧），断开自动解绑。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json(createPair());
}

export async function GET(req: Request) {
  const pair = (new URL(req.url).searchParams.get('pair') || '').trim();
  if (!/^\d{6}$/.test(pair)) {
    return NextResponse.json({ error: '无效的配对码' }, { status: 400 });
  }

  // SSE 订阅模式（TV 端）
  const isSse = new URL(req.url).searchParams.get('mode') === 'sse';
  if (isSse) {
    if (!isValidPair(pair)) {
      return NextResponse.json({ error: '配对码不存在或已过期' }, { status: 404 });
    }
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // 流已断开：走 abort 清理
          }
        };
        const ok = subscribePair(pair, send);
        if (!ok) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: '该配对码已在其他页面订阅' })}\n\n`));
          controller.close();
          closed = true;
          return;
        }
        send({ connected: true, capabilities: REMOTE_CAPABILITIES });
        // 心跳注释帧：防止中间层闲置断连（SSE 注释行不触发 onmessage）
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            /* 同上 */
          }
        }, 15000);

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribePair(pair);
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        };
        req.signal.addEventListener('abort', cleanup);
      },
      cancel() {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribePair(pair);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  // 能力描述模式（手机端扫码后）
  return NextResponse.json({ valid: isValidPair(pair), capabilities: REMOTE_CAPABILITIES });
}
