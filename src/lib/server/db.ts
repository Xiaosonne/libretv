import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 服务端 SQLite 持久化（node:sqlite 内置模块，零原生依赖）。
 *
 * 此前服务端完全无状态，检测结果/收藏等只存在各设备浏览器里；
 * 本模块引入单一数据库文件，承载三类数据：
 * - source_detections：源检测流水线结果（可用性 / 画质 / 病毒特征），全设备共享；
 * - blocked_sources：木马/劫持源域名黑名单（自动拉黑 + 手动维护）；
 * - favorites：个人片单（单密码部署全家共享一份列表，后期扩展多用户时再加 user 维度）。
 *
 * 数据目录由 LIBRETV_DATA_DIR 指定（Docker 挂卷 /app/data），默认 <cwd>/data。
 * dev 模式 HMR 会反复重载模块，用 globalThis 缓存连接避免重复打开。
 */

export interface SourceDetectionRow {
  url: string;
  ok: boolean;
  ms?: number;
  resultCount?: number;
  error?: string;
  qualityHeight?: number;
  malware: 'unknown' | 'clean' | 'suspicious';
  malwareReason?: string;
  checkedAt: number;
}

export interface BlockedSourceRow {
  host: string;
  reason?: string;
  origin: 'auto' | 'manual';
  createdAt: number;
}

export interface FavoriteRow {
  id: string;
  title: string;
  cover?: string;
  rating?: string;
  isTv?: boolean;
  doubanId?: string;
  addedAt: number;
  updatedAt: number;
}

/** 数据目录（可被环境变量重定向；Docker 内挂卷到 /app/data） */
export function dataDir(): string {
  return process.env.LIBRETV_DATA_DIR || path.join(process.cwd(), 'data');
}

function dbPath(): string {
  return path.join(dataDir(), 'libretv.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_detections (
  url            TEXT PRIMARY KEY,
  ok             INTEGER NOT NULL,
  ms             INTEGER,
  result_count   INTEGER,
  error          TEXT,
  quality_height INTEGER,
  malware        TEXT NOT NULL DEFAULT 'unknown' CHECK (malware IN ('unknown','clean','suspicious')),
  malware_reason TEXT,
  checked_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked_sources (
  host       TEXT PRIMARY KEY,
  reason     TEXT,
  origin     TEXT NOT NULL CHECK (origin IN ('auto','manual')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  cover      TEXT,
  rating     TEXT,
  is_tv      INTEGER,
  douban_id  TEXT,
  added_at   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const g = globalThis as typeof globalThis & { __libretvDb?: DatabaseSync };

/** 打开（或复用）数据库连接；首次打开时建表 */
export function getDb(): DatabaseSync {
  if (g.__libretvDb) return g.__libretvDb;
  fs.mkdirSync(dataDir(), { recursive: true });
  const db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  g.__libretvDb = db;
  return g.__libretvDb;
}

/** 关闭并清空缓存的连接（测试隔离用；进程生命周期内一般不调用） */
export function closeDb(): void {
  g.__libretvDb?.close();
  g.__libretvDb = undefined;
}

// —— 源检测结果 ——

export function upsertDetections(rows: Array<Omit<SourceDetectionRow, 'checkedAt'> & { checkedAt?: number }>): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO source_detections (url, ok, ms, result_count, error, quality_height, malware, malware_reason, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       ok=excluded.ok, ms=excluded.ms, result_count=excluded.result_count, error=excluded.error,
       quality_height=excluded.quality_height, malware=excluded.malware,
       malware_reason=excluded.malware_reason, checked_at=excluded.checked_at`
  );
  const now = Date.now();
  for (const r of rows) {
    stmt.run(
      r.url,
      r.ok ? 1 : 0,
      r.ms ?? null,
      r.resultCount ?? null,
      r.error ?? null,
      r.qualityHeight ?? null,
      r.malware,
      r.malwareReason ?? null,
      r.checkedAt ?? now
    );
  }
}

export function listDetections(): Record<string, SourceDetectionRow> {
  const rows = getDb()
    .prepare('SELECT * FROM source_detections')
    .all() as Record<string, unknown>[];
  const out: Record<string, SourceDetectionRow> = {};
  for (const r of rows) {
    out[String(r.url)] = {
      url: String(r.url),
      ok: Number(r.ok) === 1,
      ms: r.ms == null ? undefined : Number(r.ms),
      resultCount: r.result_count == null ? undefined : Number(r.result_count),
      error: (r.error as string) ?? undefined,
      qualityHeight: r.quality_height == null ? undefined : Number(r.quality_height),
      malware: (r.malware as SourceDetectionRow['malware']) ?? 'unknown',
      malwareReason: (r.malware_reason as string) ?? undefined,
      checkedAt: Number(r.checked_at),
    };
  }
  return out;
}

// —— 域名黑名单 ——

export function blockHost(host: string, reason?: string, origin: 'auto' | 'manual' = 'auto'): void {
  getDb()
    .prepare(
      `INSERT INTO blocked_sources (host, reason, origin, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET reason=COALESCE(excluded.reason, reason), origin=excluded.origin`
    )
    .run(host, reason ?? null, origin, Date.now());
}

export function unblockHost(host: string): boolean {
  const r = getDb().prepare('DELETE FROM blocked_sources WHERE host = ?').run(host);
  return Number(r.changes) > 0;
}

export function listBlockedHosts(): BlockedSourceRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM blocked_sources ORDER BY created_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    host: String(r.host),
    reason: (r.reason as string) ?? undefined,
    origin: (r.origin as BlockedSourceRow['origin']) ?? 'auto',
    createdAt: Number(r.created_at),
  }));
}

export function isHostBlocked(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return getDb().prepare('SELECT 1 FROM blocked_sources WHERE host = ?').get(host) !== undefined;
}

// —— 个人片单（收藏） ——

export function upsertFavorite(row: Omit<FavoriteRow, 'updatedAt'> & { updatedAt?: number }): void {
  getDb()
    .prepare(
      `INSERT INTO favorites (id, title, cover, rating, is_tv, douban_id, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, cover=excluded.cover, rating=excluded.rating,
         is_tv=excluded.is_tv, douban_id=excluded.douban_id, updated_at=excluded.updated_at`
    )
    .run(
      row.id,
      row.title,
      row.cover ?? null,
      row.rating ?? null,
      row.isTv === true ? 1 : 0,
      row.doubanId ?? null,
      row.addedAt,
      row.updatedAt ?? Date.now()
    );
}

export function deleteFavorite(id: string): boolean {
  const r = getDb().prepare('DELETE FROM favorites WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}

export function listFavorites(): FavoriteRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM favorites ORDER BY added_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    cover: (r.cover as string) ?? undefined,
    rating: (r.rating as string) ?? undefined,
    isTv: Number(r.is_tv) === 1,
    doubanId: (r.douban_id as string) ?? undefined,
    addedAt: Number(r.added_at),
    updatedAt: Number(r.updated_at),
  }));
}
