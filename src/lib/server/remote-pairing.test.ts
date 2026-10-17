import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPair,
  dispatchAction,
  isValidPair,
  REMOTE_CAPABILITIES,
  subscribePair,
  unsubscribePair,
} from './remote-pairing';

/**
 * 遥控配对注册表单测：码生成与格式、TTL 过期、单订阅者互斥、
 * 能力投递与断开清理。纯内存逻辑，无网络。
 */

beforeEach(() => {
  // 隔离 globalThis 会话表
  for (const key of Object.keys(globalThis)) {
    if (key.startsWith('__libretvRemotePairs')) delete (globalThis as Record<string, unknown>)[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(globalThis)) {
    if (key.startsWith('__libretvRemotePairs')) delete (globalThis as Record<string, unknown>)[key];
  }
});

describe('createPair', () => {
  it('生成 6 位数字码与 10 分钟有效期，能力描述随码下发', () => {
    const { pair, expiresAt, capabilities } = createPair();
    expect(pair).toMatch(/^\d{6}$/);
    expect(expiresAt - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(capabilities).toBe(REMOTE_CAPABILITIES);
    expect(isValidPair(pair)).toBe(true);
  });

  it('存续期内不生成重复码', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createPair().pair));
    expect(seen.size).toBe(50);
  });
});

describe('subscribe / dispatch', () => {
  it('事件投递给订阅者（含动作与文本）', () => {
    const { pair } = createPair();
    const received: unknown[] = [];
    expect(subscribePair(pair, (ev) => received.push(ev))).toBe(true);

    expect(dispatchAction(pair, 'input', '庆余年')).toBe(true);
    expect(dispatchAction(pair, 'search', '庆余年')).toBe(true);
    expect(dispatchAction(pair, 'clear')).toBe(true);
    expect(received).toEqual([
      { action: 'input', text: '庆余年' },
      { action: 'search', text: '庆余年' },
      { action: 'clear' },
    ]);
  });

  it('单订阅者互斥：已被订阅的码不能再被第二个页面订阅', () => {
    const { pair } = createPair();
    expect(subscribePair(pair, () => {})).toBe(true);
    expect(subscribePair(pair, () => {})).toBe(false);
  });

  it('TV 端断开后取消订阅，之后调用返回「未连接」', () => {
    const { pair } = createPair();
    subscribePair(pair, () => {});
    unsubscribePair(pair);
    expect(dispatchAction(pair, 'input', 'x')).toBe(false);
  });

  it('clear 事件不携带文本字段', () => {
    const { pair } = createPair();
    const received: Array<{ action: string; text?: string }> = [];
    subscribePair(pair, (ev) => received.push(ev));
    dispatchAction(pair, 'clear', '应当被丢弃的文本');
    expect(received[0]).toEqual({ action: 'clear' });
  });

  it('文本超长时截断到 200 字符', () => {
    const { pair } = createPair();
    const received: Array<{ action: string; text?: string }> = [];
    subscribePair(pair, (ev) => received.push(ev));
    dispatchAction(pair, 'input', 'a'.repeat(300));
    expect(received[0].text).toHaveLength(200);
  });

  it('无效 / 不存在的码不可订阅与投递', () => {
    expect(subscribePair('999999', () => {})).toBe(false);
    expect(dispatchAction('999999', 'input', 'x')).toBe(false);
  });
});
