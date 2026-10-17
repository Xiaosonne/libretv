import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 服务端 SQLite 存储层单测（node:sqlite，需 Node 22.5+）：
 * 源检测结果 upsert、域名黑名单、片单 CRUD，落库在临时目录，结束后清理。
 */

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-db-test-'));
  process.env.LIBRETV_DATA_DIR = tmpDir;
});

afterAll(async () => {
  // 先关闭连接（释放 WAL 文件句柄）再清理临时目录，否则 Windows 上 rmSync 会 EPERM
  const { closeDb } = await import('./db');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LIBRETV_DATA_DIR;
});

describe('源检测结果', () => {
  it('upsert 覆盖旧值并共享 checkedAt 默认值', async () => {
    const { upsertDetections, listDetections } = await import('./db');

    upsertDetections([
      { url: 'https://a.example/api.php/provide/vod', ok: true, ms: 120, resultCount: 30, qualityHeight: 1080, malware: 'clean' },
    ]);
    upsertDetections([
      {
        url: 'https://a.example/api.php/provide/vod',
        ok: false,
        ms: 400,
        error: 'HTTP 500',
        malware: 'suspicious',
        malwareReason: '返回 HTML',
      },
    ]);

    const all = listDetections();
    const row = all['https://a.example/api.php/provide/vod'];
    expect(row).toBeDefined();
    expect(row.ok).toBe(false);
    expect(row.error).toBe('HTTP 500');
    expect(row.malware).toBe('suspicious');
    expect(row.qualityHeight).toBeUndefined(); // upsert 整行覆盖
    expect(row.checkedAt).toBeGreaterThan(0);
  });
});

describe('域名黑名单', () => {
  it('自动拉黑 / 手动覆盖 / 解除 / 判定', async () => {
    const { blockHost, unblockHost, listBlockedHosts, isHostBlocked } = await import('./db');

    blockHost('evil.example', '疑似劫持', 'auto');
    expect(isHostBlocked('https://evil.example/api.php/provide/vod')).toBe(true);
    expect(isHostBlocked('https://good.example/api.php/provide/vod')).toBe(false);
    // 无法解析的 URL 一律不判拉黑
    expect(isHostBlocked('not-a-url')).toBe(false);

    // 手动拉黑同域名：origin 更新为 manual，原 reason 保留（COALESCE）
    blockHost('evil.example', undefined, 'manual');
    const listed = listBlockedHosts();
    const evil = listed.find((b) => b.host === 'evil.example');
    expect(evil?.origin).toBe('manual');
    expect(evil?.reason).toBe('疑似劫持');

    expect(unblockHost('evil.example')).toBe(true);
    expect(unblockHost('evil.example')).toBe(false);
    expect(isHostBlocked('https://evil.example/api.php/provide/vod')).toBe(false);
  });
});

describe('我的片单', () => {
  it('upsert / 删除 / 按加入时间倒序列出', async () => {
    const { upsertFavorite, deleteFavorite, listFavorites } = await import('./db');

    upsertFavorite({ id: 'db_1', title: '庆余年', rating: '8.0', isTv: true, doubanId: '1', addedAt: 1000 });
    upsertFavorite({ id: 'n_Movie', title: '某电影', isTv: false, addedAt: 2000 });
    // 同 id upsert：保留 addedAt、更新内容
    upsertFavorite({ id: 'db_1', title: '庆余年（第二季）', rating: '8.5', isTv: true, doubanId: '1', addedAt: 1000 });

    const list = listFavorites();
    expect(list.map((f) => f.id)).toEqual(['n_Movie', 'db_1']); // addedAt 倒序
    const updated = list.find((f) => f.id === 'db_1')!;
    expect(updated.title).toBe('庆余年（第二季）');
    expect(updated.addedAt).toBe(1000);
    expect(updated.isTv).toBe(true);

    expect(deleteFavorite('n_Movia')).toBe(false); // 不存在的 id
    expect(deleteFavorite('n_Movie')).toBe(true);
    expect(listFavorites()).toHaveLength(1);
  });
});
