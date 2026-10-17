'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { api, type DoubanDetail } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { allFavorites, type FavoriteEntry } from '@/lib/db';
import { toggleFavorite } from '@/lib/favorites';
import { cn } from '@/lib/utils';
import type { DoubanItem } from '@/lib/types';
import { DoubanCard } from './video-card';
import { Icon } from './icon';
import { EmptyState, Spinner } from './states';
import { SmartImage } from './smart-image';
import { useToast } from './toast';

const MOVIE_TAGS = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动画'];
const TV_TAGS = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 首页推荐区：顶部「推荐 / 我的片单」两个 tab。
 * - 推荐：数据源由设置决定（豆瓣热门 / Bangumi 新番放送 / 影视热榜）；
 * - 我的片单：本地 IndexedDB + 服务端云端同步（单密码部署全家共享），点击卡片看详情，点播放走搜索。
 */
export function RecommendSection({ onPick }: { onPick: (title: string) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const recommendSource = useAppStore((s) => s.recommendSource);
  const [tab, setTab] = useState<'recommend' | 'favorites'>('recommend');

  if (!doubanEnabled) return null;

  return (
    <section aria-label="影视推荐">
      <div className="flex items-center mb-3">
        <div className="flex bg-chip rounded-lg p-0.5">
          <TypeButton active={tab === 'recommend'} onClick={() => setTab('recommend')}>
            推荐
          </TypeButton>
          <TypeButton active={tab === 'favorites'} onClick={() => setTab('favorites')}>
            我的片单
          </TypeButton>
        </div>
      </div>

      {tab === 'favorites' ? (
        <FavoritesView onPlay={onPick} />
      ) : recommendSource === 'bangumi' ? (
        <BangumiView onPick={onPick} />
      ) : recommendSource === 'hot-list' ? (
        <HotListView onPick={onPick} />
      ) : (
        <DoubanView onPick={onPick} />
      )}
    </section>
  );
}

/** 已收藏条目的 id 集合（useLiveQuery 订阅 IndexedDB，收藏态实时联动） */
function useFavoriteIds(): Set<string> {
  const favorites = useLiveQuery(() => allFavorites(), []);
  return useMemo(() => new Set((favorites ?? []).map((f) => f.id)), [favorites]);
}

/** 推荐条目网格：卡片带收藏按钮（豆瓣条目以 subject id 为主键） */
function RecommendGrid({ items, onPick, favoriteIds }: { items: DoubanItem[]; onPick: (t: string) => void; favoriteIds: Set<string> }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {items.map((item) => (
        <DoubanCard
          key={item.id}
          item={item}
          favorited={favoriteIds.has(`db_${item.id}`)}
          onToggleFavorite={() =>
            void toggleFavorite({
              doubanId: item.id,
              title: item.title,
              cover: item.cover,
              rating: item.rating,
              isTv: item.isTv,
            })
          }
          onClick={() => onPick(item.title)}
        />
      ))}
    </div>
  );
}

/**
 * 豆瓣推荐：影视切换 + 标签筛选。
 * 一次性渲染全部条目：数据本就一次拉全（50 条），卡片图片又是 lazy 加载，
 * 视口外的图不会请求，因此不需要「加载更多」这类本地切片分页来打断浏览。
 */
function DoubanView({ onPick }: { onPick: (title: string) => void }) {
  const [type, setType] = useState<'movie' | 'tv'>('movie');
  const [tag, setTag] = useState('热门');
  const favoriteIds = useFavoriteIds();

  const query = useQuery({
    queryKey: ['douban', type, tag],
    queryFn: ({ signal }) => api.douban(type, tag, 0, 50, signal),
  });

  const tags = type === 'movie' ? MOVIE_TAGS : TV_TAGS;
  const items = query.data?.items ?? [];

  const switchType = (t: 'movie' | 'tv') => {
    if (t === type) return;
    setType(t);
    setTag('热门');
  };

  return (
    <div aria-label="豆瓣推荐">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex bg-chip rounded-lg p-0.5">
            <TypeButton active={type === 'movie'} onClick={() => switchType('movie')}>
              电影
            </TypeButton>
            <TypeButton active={type === 'tv'} onClick={() => switchType('tv')}>
              剧集
            </TypeButton>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {tags.map((t) => (
          <button
            key={t}
            className={cn(
              'px-2.5 py-1 rounded-full text-xs transition-colors',
              t === tag ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => setTag(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无推荐内容</p>
      ) : (
        <RecommendGrid items={items} onPick={onPick} favoriteIds={favoriteIds} />
      )}
    </div>
  );
}

/** Bangumi 每日放送：星期筛选，一次拉全量无分页 */
function BangumiView({ onPick }: { onPick: (title: string) => void }) {
  const [weekday, setWeekday] = useState<number | 'all'>('all');
  const favoriteIds = useFavoriteIds();

  const query = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
  });

  let items: DoubanItem[] = [];
  if (query.data) {
    items = weekday === 'all'
      ? query.data.days.flatMap((d) => d.items)
      : (query.data.days.find((d) => d.weekday === weekday)?.items ?? []);
  }

  return (
    <div aria-label="新番放送推荐">
      <div className="flex flex-wrap gap-1.5 mb-4">
        <ChipButton active={weekday === 'all'} onClick={() => setWeekday('all')}>
          全部
        </ChipButton>
        {WEEKDAYS.map((name, i) => (
          <ChipButton key={name} active={weekday === i + 1} onClick={() => setWeekday(i + 1)}>
            {name}
          </ChipButton>
        ))}
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <RecommendGrid items={items} onPick={onPick} favoriteIds={favoriteIds} />
      )}
    </div>
  );
}

const HOT_LISTS = [
  { id: 'douban_movie_weekly', label: '电影周榜' },
  { id: 'douban_tv_chinese', label: '国产剧周榜' },
  { id: 'douban_tv_global', label: '海外剧周榜' },
  { id: 'douban_show_chinese', label: '国内综艺' },
  { id: 'douban_show_global', label: '海外综艺' },
  { id: 'baidu_teleplay', label: '百度热播剧' },
];

/** 影视热榜（60s API）：豆瓣五个周榜 + 百度热播剧，chips 切换 */
function HotListView({ onPick }: { onPick: (title: string) => void }) {
  const [listId, setListId] = useState(HOT_LISTS[0].id);
  const favoriteIds = useFavoriteIds();

  const query = useQuery({
    queryKey: ['hot-list', listId],
    queryFn: ({ signal }) => api.hotList(listId, signal),
  });

  const items = query.data?.items ?? [];

  return (
    <div aria-label="影视榜单推荐">
      <div className="flex flex-wrap gap-1.5 mb-4">
        {HOT_LISTS.map((l) => (
          <ChipButton key={l.id} active={listId === l.id} onClick={() => setListId(l.id)}>
            {l.label}
          </ChipButton>
        ))}
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <RecommendGrid items={items} onPick={onPick} favoriteIds={favoriteIds} />
      )}
    </div>
  );
}

/** 我的片单：点击卡片打开详情（简介/演职员），点「播放」再走搜索流程 */
function FavoritesView({ onPlay }: { onPlay: (title: string) => void }) {
  const favorites = useLiveQuery(() => allFavorites(), []);
  const [detail, setDetail] = useState<FavoriteEntry | null>(null);

  if (favorites === undefined) return <GridSkeleton />;
  if (favorites.length === 0) {
    return (
      <EmptyState
        icon="heart"
        title="片单还是空的"
        description="在推荐内容左上角点 ❤ 收藏喜欢的电影和剧集；全家用同一个密码共享这份片单"
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
        {favorites.map((f) => (
          <DoubanCard
            key={f.id}
            item={{ id: f.id, title: f.title, cover: f.cover ?? '', rating: f.rating, isTv: f.isTv }}
            favorited
            onToggleFavorite={() =>
              void toggleFavorite({
                id: f.id,
                doubanId: f.doubanId,
                title: f.title,
                cover: f.cover,
                rating: f.rating,
                isTv: f.isTv,
              })
            }
            onClick={() => setDetail(f)}
          />
        ))}
      </div>

      {detail && (
        <FavoriteDetailModal
          entry={detail}
          onClose={() => setDetail(null)}
          onPlay={(title) => {
            setDetail(null);
            onPlay(title);
          }}
        />
      )}
    </>
  );
}

/**
 * 片单详情弹窗：条目本身只有标题/封面/评分，有豆瓣 id 时按需拉取
 * 简介/年份/地区/类型/演职员补全；拉取失败降级展示基本信息，不阻断播放。
 */
function FavoriteDetailModal({
  entry,
  onClose,
  onPlay,
}: {
  entry: FavoriteEntry;
  onClose: () => void;
  onPlay: (title: string) => void;
}) {
  const { toast } = useToast();
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['douban-detail', entry.doubanId],
    queryFn: ({ signal }) => api.doubanDetail(entry.doubanId!, signal),
    enabled: !!entry.doubanId,
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
  });
  const d: DoubanDetail | undefined = detailQuery.data;

  const rating = entry.rating ?? d?.rating;
  const cover = entry.cover || d?.cover;

  const play = () => {
    onPlay(entry.title);
  };

  const remove = () => {
    void toggleFavorite({
      id: entry.id,
      doubanId: entry.doubanId,
      title: entry.title,
      cover: entry.cover,
      rating: entry.rating,
      isTv: entry.isTv,
    }).then(() => toast(`已从片单移除「${entry.title}」`, 'info'));
    onClose();
  };

  const metaParts = [d?.year, d?.region, d?.genres?.join(' / ')].filter(Boolean) as string[];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`片单详情：${entry.title}`}
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-surface rounded-xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-xl animate-fade-in">
        <button
          className="absolute top-3 right-3 z-10 rounded-full p-1.5 bg-black/50 text-white/90 hover:text-content hover:bg-black/70 transition-colors"
          onClick={onClose}
          aria-label="关闭"
        >
          <Icon name="close" className="w-4 h-4" />
        </button>

        <div className="flex gap-4 p-4">
          <div className="w-[120px] shrink-0 aspect-[2/3] rounded-lg overflow-hidden bg-chip">
            {cover && !imgFailed ? (
              <SmartImage
                url={cover}
                mode={imageProxyMode}
                customProxy={customImageProxy}
                alt={entry.title}
                className="w-full h-full object-cover"
                onExhausted={() => setImgFailed(true)}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Icon name="heart" className="w-8 h-8 text-faint" />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-content pr-8">{entry.title}</h2>
            {rating && (
              <p className="mt-1 text-sm text-rating font-medium" title="豆瓣评分">
                ★ {rating}
              </p>
            )}
            {metaParts.length > 0 && <p className="mt-1.5 text-xs text-muted">{metaParts.join(' · ')}</p>}
            {(d?.directors?.length ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted truncate" title={d?.directors?.join(' / ')}>
                导演：{d?.directors?.join(' / ')}
              </p>
            )}
            {(d?.actors?.length ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted line-clamp-2" title={d?.actors?.join(' / ')}>
                主演：{d?.actors?.join(' / ')}
              </p>
            )}
          </div>
        </div>

        <div className="px-4 pb-2">
          {detailQuery.isLoading ? (
            <p className="flex items-center gap-2 text-xs text-faint py-2">
              <Spinner size="sm" /> 正在获取豆瓣详情…
            </p>
          ) : d?.summary ? (
            <p className="text-xs text-muted leading-relaxed">{d.summary}</p>
          ) : detailQuery.isError ? (
            <p className="text-xs text-faint py-2">暂无简介（豆瓣详情获取失败，不影响播放）</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 p-4 pt-2 border-t border-line">
          <button className="btn-primary flex-1" onClick={play}>
            <Icon name="play" className="w-4 h-4" />
            播放
          </button>
          <button className="btn-ghost" onClick={remove}>
            <Icon name="trash" className="w-4 h-4" />
            移除收藏
          </button>
        </div>
      </div>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
          <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn(
        'px-2.5 py-1 rounded-full text-xs transition-colors',
        active ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TypeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn('px-3.5 py-1.5 rounded-md text-sm transition-colors', active ? 'bg-accent text-on-accent' : 'text-muted hover:text-content')}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
