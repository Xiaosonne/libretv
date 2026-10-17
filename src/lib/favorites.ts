'use client';

import { db, putFavorite, removeFavoriteEntry, allFavorites, type FavoriteEntry } from './db';
import { api } from './client-api';

/**
 * 我的片单：本地 IndexedDB 为准、服务端 SQLite 做云端镜像（单密码部署全家共享一份）。
 *
 * 同步策略（防删除复活）：
 * - 增删改即时推送服务端（异步、不阻塞 UI，失败静默等下次全量同步补齐）；
 * - 登录后全量合并：按 updatedAt 新者胜；云端缺失的本地条目，只有「上次同步前就存在」
 *   （updatedAt <= lastSyncAt）才判定为云端已删、跟随删除——本机新加还没推送成功的不会误删。
 */

const LAST_SYNC_KEY = 'libretv-favorites-last-sync';

function readLastSync(): number {
  try {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastSync(t: number): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(t));
  } catch {
    /* 隐私模式等无法写入时忽略：仅影响删除同步的判定 */
  }
}

export interface FavoriteInput {
  id?: string;
  title: string;
  cover?: string;
  rating?: string;
  isTv?: boolean;
  doubanId?: string;
}

/** 收藏主键：豆瓣条目用 subject id（跨设备天然一致）；无豆瓣信息用标题兜底 */
export function favoriteIdOf(input: { id?: string; doubanId?: string; title: string }): string {
  if (input.id) return input.id;
  if (input.doubanId) return `db_${input.doubanId}`;
  return `n_${input.title}`;
}

export async function isFavorited(id: string): Promise<boolean> {
  return (await db.favorites.get(id)) !== undefined;
}

/** 新增/更新收藏：立即写本地并异步推送服务端 */
export async function addFavorite(input: FavoriteInput): Promise<void> {
  const id = favoriteIdOf(input);
  const now = Date.now();
  const existing = await db.favorites.get(id);
  const entry: FavoriteEntry = {
    id,
    title: input.title,
    cover: input.cover,
    rating: input.rating,
    isTv: input.isTv,
    doubanId: input.doubanId,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };
  await putFavorite(entry);
  api.pushFavorite(entry).catch(() => {});
}

/** 取消收藏：立即删本地并异步推送服务端 */
export async function removeFavorite(id: string): Promise<void> {
  await removeFavoriteEntry(id);
  api.deleteFavorite(id).catch(() => {});
}

/** 切换收藏状态，返回切换后是否已收藏 */
export async function toggleFavorite(input: FavoriteInput): Promise<boolean> {
  const id = favoriteIdOf(input);
  if (await isFavorited(id)) {
    await removeFavorite(id);
    return false;
  }
  await addFavorite(input);
  return true;
}

/**
 * 登录后全量同步。任一失败（未登录/离线）静默跳过，不影响本地使用；
 * 推送失败的改动会在下一次全量合并时按 updatedAt 新者胜补齐。
 */
export async function syncFavorites(): Promise<void> {
  let cloud: FavoriteEntry[];
  try {
    cloud = (await api.listFavorites()).list;
  } catch {
    return;
  }
  const sync = readLastSync();
  const cloudIds = new Set(cloud.map((e) => e.id));

  for (const c of cloud) {
    const local = await db.favorites.get(c.id);
    // 云端更新（或本地没有）才覆盖：本地改动即时推送过，updatedAt 不会落后于云端
    if (!local || c.updatedAt > local.updatedAt) await putFavorite(c);
  }

  const local = await allFavorites();
  for (const l of local) {
    if (!cloudIds.has(l.id) && l.updatedAt <= sync) {
      // 云端已不存在且不是本机未同步的新改动 → 其他设备删除了，跟随删除
      await removeFavoriteEntry(l.id);
    } else if (!cloudIds.has(l.id)) {
      // 本机新改动（推送可能失败过）→ 重新推送
      api.pushFavorite(l).catch(() => {});
    }
  }

  writeLastSync(Date.now());
}
