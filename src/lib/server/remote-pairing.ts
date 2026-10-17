/**
 * 局域网手机遥控：配对注册表（内存态，进程重启即失效，无需持久化）。
 *
 * 交互模型 =「能力描述 + 能力调用」：
 * - TV 端 POST /api/remote/pair 生成 6 位配对码，并把本页能力（输入文字 / 搜索 / 清空）
 *   编码进二维码（指向 /remote?pair=xxx）；
 * - 手机扫码打开 /remote，GET /api/remote/pair?pair=xxx 拉取能力面板描述并渲染；
 * - 手机操作时 POST /api/remote/send {pair, action, text} 调用能力；
 * - TV 端 EventSource 订阅 GET /api/remote/pair?pair=xxx&mode=sse 接收事件流。
 *
 * 安全边界：pair/send 不走登录态（手机端扫码即用，输密码违背免打字初衷），
 * 以「短时效一次性配对码 + 单订阅者 + 动作白名单 + 文本长度限制」控风险；
 * 生成配对码的 POST 走 guardRequest，防止未登录者批量刷码。
 */

export type RemoteAction = 'input' | 'search' | 'clear';

export interface RemoteEvent {
  action: RemoteAction;
  text?: string;
}

/** 本页能力描述（第一版：输入 + 搜索；后续可按页面动态注册更多能力） */
export const REMOTE_CAPABILITIES = {
  page: '/',
  pageName: '搜索页',
  actions: [
    { id: 'input', label: '输入文字', withText: true, description: '手机端输入实时同步到电视搜索框' },
    { id: 'search', label: '搜索', withText: true, description: '电视端用当前文字立即发起搜索' },
    { id: 'clear', label: '清空', withText: false, description: '清空电视端搜索框' },
  ],
} as const;

const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_TEXT_LENGTH = 200;

interface PairSession {
  createdAt: number;
  expiresAt: number;
  /** SSE 订阅回调；TV 端断开或超时后为 undefined */
  subscriber?: (event: RemoteEvent) => void;
}

const g = globalThis as typeof globalThis & { __libretvRemotePairs?: Map<string, PairSession> };
function sessions(): Map<string, PairSession> {
  g.__libretvRemotePairs ??= new Map();
  return g.__libretvRemotePairs;
}

/** 惰性清理过期会话 */
function sweep(): void {
  const now = Date.now();
  for (const [code, s] of sessions()) {
    if (s.expiresAt < now) sessions().delete(code);
  }
}

export interface PairInfo {
  pair: string;
  expiresAt: number;
  capabilities: typeof REMOTE_CAPABILITIES;
}

/** 生成新配对码（6 位数字，不与存活中的码重复） */
export function createPair(): PairInfo {
  sweep();
  let code: string;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (sessions().has(code));
  const now = Date.now();
  sessions().set(code, { createdAt: now, expiresAt: now + PAIR_TTL_MS });
  return { pair: code, expiresAt: now + PAIR_TTL_MS, capabilities: REMOTE_CAPABILITIES };
}

/** 校验配对码：存在且未过期 */
export function isValidPair(pair: string): boolean {
  sweep();
  return sessions().has(pair);
}

/** TV 端订阅事件流；该码已被其他页面订阅时返回 false（单订阅者） */
export function subscribePair(pair: string, subscriber: (event: RemoteEvent) => void): boolean {
  sweep();
  const session = sessions().get(pair);
  if (!session) return false;
  if (session.subscriber) return false;
  session.subscriber = subscriber;
  return true;
}

/** TV 端断开时解除订阅（配对码保留，可重新连接直到过期） */
export function unsubscribePair(pair: string): void {
  const session = sessions().get(pair);
  if (session) session.subscriber = undefined;
}

/**
 * 手机端调用能力；投递给当前订阅者，返回 false 表示码无效或 TV 端未连接。
 */
export function dispatchAction(pair: string, action: RemoteAction, text?: string): boolean {
  sweep();
  const session = sessions().get(pair);
  if (!session) return false;
  const event: RemoteEvent = {
    action,
    ...(action === 'clear' ? {} : { text: (text ?? '').slice(0, MAX_TEXT_LENGTH) }),
  };
  if (!session.subscriber) return false;
  session.subscriber(event);
  return true;
}

export { MAX_TEXT_LENGTH };
