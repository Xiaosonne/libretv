'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/states';
import { cn } from '@/lib/utils';

/**
 * 手机遥控端（/remote?pair=xxxxxx）：TV 端扫码后打开本页。
 *
 * 页面渲染 TV 端声明的能力面板（能力描述来自 /api/remote/pair?pair=），
 * 用户操作时 POST /api/remote/send 调用对应能力（能力调用）：
 * - 输入框：文字变化实时推送「input」（电视端搜索框同步显示）；
 * - 搜索：推送「search」，电视端用当前文字立即搜索；
 * - 清空：推送「clear」。
 * 不依赖登录态：短时效配对码即凭证（10 分钟有效，TV 端断开面板后调用会得到明确报错）。
 */
export default function RemotePage() {
  return (
    <Suspense>
      <RemoteContent />
    </Suspense>
  );
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready'; connectedHint: string };

/** TV 端声明的能力描述；旧版服务端未下发时回落到搜索页默认面板 */
interface Caps {
  pageName: string;
  placeholder: string;
  confirmLabel: string;
  clearLabel: string;
  inputMode: 'text' | 'url';
  hint: string;
}
const DEFAULT_CAPS: Caps = {
  pageName: '搜索页',
  placeholder: '输入要搜索的片名…',
  confirmLabel: '电视端搜索',
  clearLabel: '清空搜索框',
  inputMode: 'text',
  hint: '输入内容会实时显示在电视搜索框上；点击「电视端搜索」立即在电视上发起搜索。',
};

function RemoteContent() {
  const searchParams = useSearchParams();
  const pair = (searchParams.get('pair') || '').trim();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [caps, setCaps] = useState<Caps>(DEFAULT_CAPS);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 输入框内容变化后推送：仅当变化由用户键入产生时（初始回显由 remote 事件回流触发时不推送）
  const skipPushRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/remote/pair?pair=${encodeURIComponent(pair)}`);
        if (!res.ok) {
          if (!cancelled) setPhase({ kind: 'invalid', message: '配对码格式不正确，请重新扫码' });
          return;
        }
        const data = (await res.json()) as { valid: boolean; capabilities?: Partial<Caps> };
        if (cancelled) return;
        if (!data.valid) {
          setPhase({ kind: 'invalid', message: '配对码不存在或已过期（10 分钟有效），请在电视端重新打开配对面板' });
          return;
        }
        // 能力描述以 TV 端声明为准（服务端已过白名单），缺失字段回落默认值
        setCaps({ ...DEFAULT_CAPS, ...data.capabilities });
        setPhase({ kind: 'ready', connectedHint: '已连接电视端' });
      } catch {
        if (!cancelled) setPhase({ kind: 'invalid', message: '无法连接电视端服务，请确认在同一局域网' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pair]);

  /** 调用 TV 端能力；404/409 等业务错误上屏提示 */
  const call = useCallback(
    async (action: 'input' | 'search' | 'clear', value?: string) => {
      setSending(true);
      setError(null);
      try {
        const res = await fetch('/api/remote/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pair, action, text: value }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error || '操作失败，请重试');
        }
      } catch {
        setError('网络请求失败，请确认电视端与手机在同一网络');
      } finally {
        setSending(false);
      }
    },
    [pair]
  );

  if (phase.kind === 'loading') {
    return (
      <Shell>
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner size="sm" /> 正在连接电视端…
        </p>
      </Shell>
    );
  }

  if (phase.kind === 'invalid') {
    return (
      <Shell>
        <div className="text-center space-y-3">
          <Icon name="alert" className="w-10 h-10 text-warning mx-auto" />
          <p className="text-sm text-muted leading-relaxed">{phase.message}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell pageName={caps.pageName}>
      <div className="flex items-center justify-center gap-1.5 text-xs text-faint mb-5" aria-live="polite">
        <span className={cn('w-1.5 h-1.5 rounded-full inline-block', sending ? 'bg-accent animate-pulse' : 'bg-success')} />
        {error ? <span className="text-danger">{error}</span> : phase.connectedHint}
      </div>

      {/* 输入区：文字实时同步到电视端当前页面的输入框 */}
      <div className="flex items-stretch min-h-12 rounded-xl border border-line bg-chip focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40 overflow-hidden">
        <input
          className="flex-1 min-w-0 px-4 bg-transparent text-base text-content placeholder:text-faint focus:outline-none"
          placeholder={caps.placeholder}
          value={text}
          maxLength={200}
          inputMode={caps.inputMode}
          enterKeyHint="go"
          onChange={(e) => {
            setText(e.target.value);
            // 首次挂载回显不推送；此后每次变化即时同步到电视端
            if (skipPushRef.current) {
              skipPushRef.current = false;
              return;
            }
            void call('input', e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void call('search', text);
          }}
          aria-label="遥控输入内容"
          autoFocus
        />
        {text && (
          <button
            type="button"
            className="shrink-0 self-center px-3 text-xs text-faint hover:text-content"
            onClick={() => {
              setText('');
              skipPushRef.current = true;
              void call('clear');
            }}
            aria-label="清空"
          >
            清空
          </button>
        )}
      </div>

      {/* 能力调用区：按钮文案由 TV 端能力声明决定（搜索页=搜索，订阅页=同步订阅） */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          className="btn-ghost py-3 text-sm"
          onClick={() => void call('clear')}
          disabled={sending}
        >
          <Icon name="close" className="w-4 h-4" />
          {caps.clearLabel}
        </button>
        <button
          className="btn-primary py-3 text-sm font-medium"
          onClick={() => void call('search', text)}
          disabled={sending || !text.trim()}
        >
          <Icon name="search" className="w-4 h-4" />
          {caps.confirmLabel}
        </button>
      </div>

      <p className="mt-6 text-center text-xs text-faint leading-relaxed">{caps.hint}</p>
    </Shell>
  );
}

function Shell({ children, pageName }: { children: React.ReactNode; pageName?: string }) {
  return (
    <main className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <header className="text-center mb-6">
          <h1 className="text-lg font-semibold text-content flex items-center justify-center gap-2">
            <Icon name="remote" className="w-5 h-5 text-accent" />
            LibreTV 遥控
          </h1>
          {pageName && pageName !== '搜索页' && (
            <p className="mt-1 text-xs text-faint">当前页面：{pageName}</p>
          )}
        </header>
        {children}
      </div>
    </main>
  );
}
