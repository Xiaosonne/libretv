'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '@/lib/client-api';
import { Icon } from './icon';
import { Spinner } from './states';

/**
 * 遥控输入配对弹窗（TV 端）：
 * 生成 6 位配对码并展示二维码（指向 /remote?pair=xxx），手机扫码后即可
 * 在手机端输入文字 / 触发搜索，动作经服务端 SSE 实时推回本页。
 * 弹窗关闭即断开订阅（配对码保留至过期，重开面板需重新生成）。
 */

export interface RemoteEventHandlers {
  onInput: (text: string) => void;
  onSearch: (text: string) => void;
  onClear: () => void;
}

/** TV 端声明的本页能力描述（手机端能力面板按此渲染） */
export interface RemotePageCapabilities {
  pageName: string;
  placeholder: string;
  confirmLabel: string;
  clearLabel: string;
  inputMode?: 'text' | 'url';
  hint?: string;
}

type PairState =
  | { phase: 'creating' }
  | { phase: 'ready'; pair: string; qrDataUrl: string; expiresAt: number }
  | { phase: 'error'; message: string };

export function RemotePairDialog({
  onClose,
  handlers,
  capabilities,
}: {
  onClose: () => void;
  handlers: RemoteEventHandlers;
  /** 省略时手机端渲染搜索页默认能力面板 */
  capabilities?: RemotePageCapabilities;
}) {
  const [state, setState] = useState<PairState>({ phase: 'creating' });
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  // handlers 随调用方每次渲染重建：事件回调经 ref 取最新值，SSE 只建立一次
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // capabilities 同理：配对码只在弹窗挂载时生成一次，避免父组件重渲染触发重复配对
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    void (async () => {
      try {
        const { pair } = await api.createRemotePair(capabilitiesRef.current);
        const qrDataUrl = await QRCode.toDataURL(`${window.location.origin}/remote?pair=${pair}`, {
          margin: 1,
          width: 240,
        });
        if (cancelled) return;
        setState({ phase: 'ready', pair, qrDataUrl, expiresAt: Date.now() + 10 * 60 * 1000 });

        es = new EventSource(`/api/remote/pair?pair=${pair}&mode=sse`);
        esRef.current = es;
        es.onopen = () => setConnected(true);
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data) as { connected?: boolean; action?: string; text?: string; error?: string };
            if (data.connected) {
              setConnected(true);
              return;
            }
            if (data.error) return;
            switch (data.action) {
              case 'input':
                handlersRef.current.onInput(data.text ?? '');
                break;
              case 'search':
                handlersRef.current.onSearch(data.text ?? '');
                break;
              case 'clear':
                handlersRef.current.onClear();
                break;
            }
          } catch {
            // 心跳注释帧等非 JSON 内容：忽略
          }
        };
        es.onerror = () => setConnected(false);
      } catch (err) {
        if (!cancelled) {
          setState({ phase: 'error', message: err instanceof Error ? err.message : '配对码生成失败' });
        }
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
      esRef.current = null;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="手机遥控输入配对"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-surface rounded-xl w-full max-w-sm p-6 text-center shadow-xl animate-fade-in">
        <button
          className="absolute top-3 right-3 rounded-full p-1.5 text-faint hover:text-content hover:bg-hover transition-colors"
          onClick={onClose}
          aria-label="关闭"
        >
          <Icon name="close" className="w-4 h-4" />
        </button>

        <h2 className="text-base font-semibold text-content">手机遥控输入</h2>

        {state.phase === 'creating' && (
          <p className="flex items-center justify-center gap-2 text-sm text-muted py-10">
            <Spinner size="sm" /> 正在生成配对码…
          </p>
        )}

        {state.phase === 'error' && <p className="text-sm text-danger py-10">{state.message}</p>}

        {state.phase === 'ready' && (
          <>
            {/* 二维码为本地生成的 dataURL（无需 CDN 优化），不走 next/image */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={state.qrDataUrl} alt="用手机扫码连接遥控输入" className="mx-auto mt-4 rounded-lg bg-white p-2" />
            <p className="mt-3 text-sm text-muted">
              用手机浏览器扫码（与本设备同一局域网），或手动输入配对码
            </p>
            <p className="mt-1 text-3xl font-bold tracking-[0.3em] text-accent tabular-nums">{state.pair}</p>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs" aria-live="polite">
              {connected ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                  <span className="text-success">手机已连接，直接在手机上输入即可</span>
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-chip inline-block" />
                  <span className="text-faint">等待手机连接…（配对码 10 分钟内有效）</span>
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** 入口按钮 + 弹窗编排（供页面挂载）：capabilities 声明本页能力，手机端按声明渲染 */
export function useRemotePairing(handlers: RemoteEventHandlers, capabilities?: RemotePageCapabilities) {
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);

  // capabilities 相对静态：仅作为弹窗打开瞬间的初始值参与依赖判断
  const dialog = open ? <RemotePairDialog onClose={closeDialog} handlers={handlers} capabilities={capabilities} /> : null;
  return { openDialog, dialog };
}
