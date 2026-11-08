import { useMemo, useState } from 'react'
import { ImageIcon, SearchIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/boardui/button'
import { Input } from '@/components/ai/input'
import type { Template } from './types'

const categoryLabels: Record<string, string> = {
  mine: '我的模板',
  fun: '人像趣味',
  policy: '销售政策',
  reward: '销售奖励',
  ranking: '排行榜',
  poster: '销售海报',
  comic: '漫画分镜',
  infographic: '销售图表',
  social: '营销社媒',
}

type Props = {
  templates: Template[]
  mine: Template[]
  onRemoveMine: (id: string) => void
  state: 'idle' | 'loading' | 'ready' | 'error'
  onRetry: () => void
  onPick: (template: Template) => void
}

export function TemplatesPane({ templates, mine, onRemoveMine, state, onRetry, onPick }: Props) {
  const [removing, setRemoving] = useState<string | null>(null)
  const all = useMemo(() => [...mine, ...templates], [mine, templates])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const categories = useMemo(
    () => Array.from(new Set(all.map((t) => t.category).filter(Boolean))) as string[],
    [all],
  )
  const shown = all.filter(
    (t) =>
      (category === 'all' || t.category === category) &&
      (!query.trim() || `${t.title}${t.prompt}`.toLowerCase().includes(query.trim().toLowerCase())),
  )
  return (
    <div className="jl-templates mx-auto grid w-full max-w-5xl gap-6 px-4 pb-10 pt-6 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl leading-8 font-semibold">灵感模板</h2>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">选一个方向，带回对话继续改。</p>
        </div>
        <div className="relative w-full sm:w-64">
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模板"
            aria-label="搜索模板"
            className="min-h-11 pl-10 text-base"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="模板分类">
        {['all', ...categories].map((c) => (
          <Button
            key={c}
            size="small"
            variant={category === c ? 'primary' : 'secondary'}
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
          >
            {c === 'all' ? '全部' : categoryLabels[c] ?? c}
          </Button>
        ))}
      </div>
      {state === 'error' ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          平台模板加载失败
          <Button variant="secondary" size="small" onClick={onRetry}>重试</Button>
        </div>
      ) : null}
      {(state === 'loading' || state === 'idle') && mine.length === 0 ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="chat-skeleton relative aspect-[4/3] rounded-xl bg-muted" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {state === 'error' ? '' : '没有匹配的模板'}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((t) => (
            <div key={t.id} className="group relative">
              <button
                type="button"
                onClick={() => onPick(t)}
                className="jl-template-card block w-full overflow-hidden rounded-xl border border-border bg-card text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-muted">
                  <ImageIcon aria-hidden="true" className="size-8 text-muted-foreground/40" />
                  {t.preview ? <img src={t.preview} alt="" loading="lazy" decoding="async" onError={(e) => { e.currentTarget.hidden = true }} className="absolute inset-0 size-full object-cover" /> : null}
                </span>
                <span className="block px-3 pt-3 pb-1 text-sm leading-5 font-medium break-words">{t.title}</span>
                <span className="block px-3 pb-3 text-sm leading-5 text-muted-foreground">{t.private ? '我的模板' : categoryLabels[t.category ?? ''] ?? '灵感模板'}</span>
              </button>
              {t.private ? (
                removing === t.id ? (
                  <div className="absolute top-2 right-2 left-2 grid gap-1 rounded-lg bg-background p-1 shadow">
                    <Button
                      variant="danger"
                      size="xs"
                      onClick={() => {
                        onRemoveMine(t.id)
                        setRemoving(null)
                      }}
                    >
                      确认删除
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => setRemoving(null)}>取消</Button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="xs"
                    iconOnly
                    leadingIcon={Trash2Icon}
                    aria-label={`删除模板：${t.title}`}
                    title={`删除模板：${t.title}`}
                    className="absolute top-2 right-2 rounded-full"
                    onClick={() => setRemoving(t.id)}
                  />
                )
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
