import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { deleteFavorite, listFavorites, upsertFavorite } from '@/lib/server/db';

export const runtime = 'nodejs';

/**
 * 我的片单云端镜像（单密码部署全家共享一份列表，无用户维度）：
 * - GET     全量拉取（客户端按 updatedAt 新者胜合并）；
 * - POST    单条 upsert（客户端收藏/改动时即时推送）；
 * - DELETE  ?id= 删除单条（客户端取消收藏时推送）。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json({ list: listFavorites() });
}

interface FavoriteBody {
  id?: string;
  title?: string;
  cover?: string;
  rating?: string;
  isTv?: boolean;
  doubanId?: string;
  addedAt?: number;
  updatedAt?: number;
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: FavoriteBody;
  try {
    body = (await req.json()) as FavoriteBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const id = (body.id || '').trim().slice(0, 200);
  const title = (body.title || '').trim().slice(0, 200);
  if (!id || !title) {
    return NextResponse.json({ error: '缺少 id 或 title' }, { status: 400 });
  }

  upsertFavorite({
    id,
    title,
    cover: typeof body.cover === 'string' ? body.cover.slice(0, 500) : undefined,
    rating: typeof body.rating === 'string' ? body.rating.slice(0, 10) : undefined,
    isTv: body.isTv === true,
    doubanId: typeof body.doubanId === 'string' ? body.doubanId.slice(0, 20) : undefined,
    addedAt: typeof body.addedAt === 'number' && body.addedAt > 0 ? body.addedAt : Date.now(),
    updatedAt: typeof body.updatedAt === 'number' && body.updatedAt > 0 ? body.updatedAt : Date.now(),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  }
  return NextResponse.json({ ok: deleteFavorite(id) });
}
