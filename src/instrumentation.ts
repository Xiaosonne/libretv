/**
 * Next.js instrumentation：服务进程启动时执行一次。
 * 在这里拉起源巡检定时器（SQLite 存储层在首次调用时懒初始化）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startScheduler } = await import('@/lib/server/scheduler');
  startScheduler();
}
