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

/**
 * 单次配对的能力描述（TV 端打开面板时声明，手机端按声明渲染）。
 * - action id 固定为 input/search/clear 三种（白名单），语义上 search =「确认/主操作」；
 * - 展示文案（页面名/占位符/按钮标签）由 TV 端按所在页面声明，同一套动作即可服务
 *   搜索框（确认=搜索）、订阅输入框（确认=同步订阅）等不同场景。
 */
export interface RemoteCapabilities {
  /** TV 端页面名（手机端标题展示） */
  pageName: string;
  /** 手机端输入框占位文案 */
  placeholder: string;
  /** 主操作按钮文案（action=search），如「电视端搜索」/「同步订阅」 */
  confirmLabel: string;
  /** 清空按钮文案 */
  clearLabel: string;
  /** 输入框 inputmode：URL 场景用 url 键盘 */
  inputMode?: 'text' | 'url';
  /** 底部说明文字（可省） */
  hint?: string;
}

/** 默认能力描述：搜索页（TV 端不声明时使用，保持旧行为） */
export const DEFAULT_CAPABILITIES: RemoteCapabilities = {
  pageName: '搜索页',
  placeholder: '输入要搜索的片名…',
  confirmLabel: '电视端搜索',
  clearLabel: '清空搜索框',
  inputMode: 'text',
  hint: '输入内容会实时显示在电视搜索框上；点击「电视端搜索」立即在电视上发起搜索。',
};

/** TV 端声明的能力需过白名单清洗：只保留四种文案字段并限长，防止垃圾内容经二维码投屏 */
export function sanitizeCapabilities(raw: unknown): RemoteCapabilities {
  const input = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string, max: number) => {
    const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
    return s || fallback;
  };
  return {
    pageName: str(input.pageName, DEFAULT_CAPABILITIES.pageName, 20),
    placeholder: str(input.placeholder, DEFAULT_CAPABILITIES.placeholder, 40),
    confirmLabel: str(input.confirmLabel, DEFAULT_CAPABILITIES.confirmLabel, 20),
    clearLabel: str(input.clearLabel, DEFAULT_CAPABILITIES.clearLabel, 20),
    inputMode: input.inputMode === 'url' ? 'url' : 'text',
    hint: str(input.hint, DEFAULT_CAPABILITIES.hint ?? '', 80),
  };
}

const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_TEXT_LENGTH = 200;

interface PairSession {
  createdAt: number;
  expiresAt: number;
  /** 本次配对声明的能力描述（手机端能力面板的渲染来源） */
  capabilities: RemoteCapabilities;
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
  capabilities: RemoteCapabilities;
}

/** 生成新配对码（6 位数字，不与存活中的码重复），并登记本次会话的能力描述 */
export function createPair(capabilities?: RemoteCapabilities): PairInfo {
  sweep();
  let code: string;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (sessions().has(code));
  const now = Date.now();
  const caps = capabilities ?? DEFAULT_CAPABILITIES;
  sessions().set(code, { createdAt: now, expiresAt: now + PAIR_TTL_MS, capabilities: caps });
  return { pair: code, expiresAt: now + PAIR_TTL_MS, capabilities: caps };
}

/** 手机端拉取能力描述；配对码无效时返回 null */
export function getPairCapabilities(pair: string): RemoteCapabilities | null {
  sweep();
  return sessions().get(pair)?.capabilities ?? null;
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
