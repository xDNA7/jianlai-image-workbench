import { useState } from 'react'
import { FilmIcon, MessageSquareIcon, SparklesIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/boardui/button'
import accountAvatar from '../assets/account-avatar.webp'
import brandLogo from '../assets/brand-logo.png'
import { yuan } from './PlanCard'
import './navigation.css'

export type View = 'chat' | 'templates' | 'video'

const NAV: { view: View; label: string; Icon: typeof MessageSquareIcon }[] = [
  { view: 'chat', label: '对话', Icon: MessageSquareIcon },
  { view: 'templates', label: '灵感模板', Icon: SparklesIcon },
  { view: 'video', label: '视频', Icon: FilmIcon },
]

type Props = {
  view: View
  balance: number | null
  hasThread: boolean
  onView: (view: View) => void
  onClear: () => void
}

export function Sidebar({ view, balance, hasThread, onView, onClear }: Props) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="jl-sidebar-content flex h-full min-h-0 flex-col gap-3">
      <div className="jl-sidebar-brand px-2">
        <img src={brandLogo} alt="剑来生图" className="h-auto w-[112px] max-w-full" />
      </div>
      <nav aria-label="主菜单" className="grid gap-1">
        {NAV.map(({ view: v, label, Icon }) => (
          <Button
            key={v}
            variant="ghost"
            size="medium"
            leadingIcon={Icon}
            aria-current={view === v ? 'page' : undefined}
            onClick={() => onView(v)}
            className="jl-nav-item w-full justify-start"
          >
            {label}
          </Button>
        ))}
      </nav>
      <div className="jl-sidebar-footer mt-auto grid gap-3">
        {hasThread ? (
          confirming ? (
            <div className="jl-clear-confirm grid gap-3 rounded-xl border border-border p-3 text-sm leading-5">
              清空这个设备上的对话、输入和参考图，开始新对话？作品会保留，已提交的生成不会取消。
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="small"
                  onClick={() => {
                    onClear()
                    setConfirming(false)
                  }}
                >
                  清空
                </Button>
                <Button variant="ghost" size="small" onClick={() => setConfirming(false)}>取消</Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" leadingIcon={Trash2Icon} className="jl-clear-thread justify-start text-sm" onClick={() => setConfirming(true)}>清空对话</Button>
          )
        ) : null}
        <div className="jl-account flex items-center gap-3 border-t border-border pt-4">
          <img
            src={accountAvatar}
            alt=""
            width={36}
            height={36}
            className="size-9 shrink-0 rounded-full bg-muted object-cover"
          />
          <div className="min-w-0 text-sm">
            <div className="font-semibold">我的刀盾</div>
            <div className="text-sm leading-5 text-muted-foreground" aria-live="polite">
              {balance == null ? '余额读取中' : `余额 ${yuan(balance)}`}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
