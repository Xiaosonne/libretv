import { knownSourceUrls, startInspectJob } from './source-inspector';

/**
 * 源巡检定时调度：每 6h 对库中已登记的源自动复检一轮（结果落库，全设备共享）。
 *
 * - 仅巡检库里已有的地址：新源由用户在 UI 触发检测时首次入库，之后纳入巡检；
 * - dev HMR 会重载模块，用 globalThis 标记保证全进程只有一个定时器；
 * - SOURCE_AUTO_INSPECT=0 可关闭自动巡检（手动检测不受影响）。
 */

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

const g = globalThis as typeof globalThis & { __libretvScheduler?: boolean };

export function startScheduler(): void {
  if (g.__libretvScheduler) return;
  g.__libretvScheduler = true;

  if (process.env.SOURCE_AUTO_INSPECT === '0') return;
  const interval = Math.max(30 * 60 * 1000, Number(process.env.SOURCE_INSPECT_INTERVAL_MS) || DEFAULT_INTERVAL_MS);

  const run = () => {
    try {
      const urls = knownSourceUrls();
      if (urls.length > 0) startInspectJob(`auto_${Date.now().toString(36)}`, urls);
    } catch (err) {
      console.warn('[LibreTV] 自动巡检启动失败：', err instanceof Error ? err.message : err);
    }
  };

  // 启动 1 分钟后先跑一轮（避开启动高峰），之后按间隔巡检
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, interval).unref?.();
}
