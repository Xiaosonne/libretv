import { NextResponse } from 'next/server';
import { dispatchAction, isValidPair, MAX_TEXT_LENGTH, type RemoteAction } from '@/lib/server/remote-pairing';

export const runtime = 'nodejs';

/**
 * 手机端能力调用入口：POST {pair, action: 'input'|'search'|'clear', text?}。
 * 不走登录态——短时效配对码本身就是凭证；动作白名单 + 文本长度限制控风险。
 */
const ACTIONS: ReadonlySet<string> = new Set(['input', 'search', 'clear']);

export async function POST(req: Request) {
  let body: { pair?: unknown; action?: unknown; text?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const pair = typeof body.pair === 'string' ? body.pair.trim() : '';
  const action = typeof body.action === 'string' ? body.action : '';
  const text = typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT_LENGTH) : '';

  if (!/^\d{6}$/.test(pair)) {
    return NextResponse.json({ error: '无效的配对码' }, { status: 400 });
  }
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: '不支持的操作' }, { status: 400 });
  }
  if (!isValidPair(pair)) {
    return NextResponse.json({ error: '配对码不存在或已过期，请重新扫码' }, { status: 404 });
  }

  const delivered = dispatchAction(pair, action as RemoteAction, action === 'clear' ? undefined : text);
  if (!delivered) {
    return NextResponse.json({ error: '电视端未连接，请在电视上重新打开配对面板' }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
