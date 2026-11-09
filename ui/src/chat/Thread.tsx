import avatar from '../assets/account-avatar.webp'
import { Bubble, BubbleContent } from '@/components/ai/bubble'
import { Message, MessageAvatar, MessageContent } from '@/components/ai/message'
import { Button } from '@/boardui/button'
import { JobCard } from './JobCard'
import { PlanCard, yuan } from './PlanCard'
import { useTypewriter } from './typewriter'
import type { AssistantItem, Capabilities, JobImage, Plan, ThreadItem } from './types'

export type ThreadActions = {
  caps: Capabilities
  balance: number | null
  busy: boolean
  limitReached: boolean
  /** Replies created after this timestamp are revealed with the typewriter effect. */
  sessionStart: number
  onChangePlan: (id: string, plan: Plan) => void
  onConfirm: (id: string) => void
  onRebindReference?: (id: string, file: File) => Promise<void>
  onUploadReference?: (id: string, file: File) => Promise<void>
  onDismiss: (id: string) => void
  onGenerateAsWritten: (id: string) => void
  onStop: (id: string) => void
  onRetryPoll: (id: string) => void
  onRetryGeneration: (id: string) => void
  onOpen: (image: JobImage) => void
  onEdit: (image: JobImage) => void
}

function WaitingIndicator({ hasText }: { hasText: boolean }) {
  return (
    <div className="jl-chat-waiting" role="status" aria-live="polite" aria-atomic="true">
      <span className="chat-dots" aria-hidden="true"><span /><span /><span /></span>
      <span>{hasText ? '正在整理生成方案' : '正在理解需求'}</span>
    </div>
  )
}

function Avatar() {
  return <div className="jl-assistant-identity"><MessageAvatar className="size-6 min-w-6 self-center"><img src={avatar} alt="" width={24} height={24} className="size-full object-cover" /></MessageAvatar><strong>剑来</strong><span>创作助手</span></div>
}

function AssistantMessage({ item, a }: { item: AssistantItem; a: ThreadActions }) {
  const { visible, done } = useTypewriter(item.id, item.text, item.created >= a.sessionStart)
  const showText = visible.trim().length > 0
  const canFallback = item.status === 'error' && !item.plan
  const cost = yuan(a.caps.priceCents)
  return (
    <Message align="start" className="jl-ai-message">
      <Avatar />
      <MessageContent className="gap-3">
        {showText ? (
          <Bubble variant="ghost" className="jl-assistant-text max-w-full">
            <BubbleContent className="whitespace-pre-wrap px-3 py-2 leading-relaxed">
              {visible}
            </BubbleContent>
          </Bubble>
        ) : null}
        {item.status === 'streaming' && !item.plan ? <WaitingIndicator hasText={item.text.trim().length > 0} /> : null}
        {item.plan && done ? (
          <PlanCard
            item={item as AssistantItem & { plan: Plan }}
            caps={a.caps}
            balance={a.balance}
            busy={a.busy}
            onChange={(plan) => a.onChangePlan(item.id, plan)}
            onConfirm={() => a.onConfirm(item.id)}
            onRebindReference={a.onRebindReference ? (file) => a.onRebindReference!(item.id, file) : undefined}
            onUploadReference={a.onUploadReference ? (file) => a.onUploadReference!(item.id, file) : undefined}
            onDismiss={() => a.onDismiss(item.id)}
          />
        ) : null}
        {item.status === 'error' && item.error ? (
          <p role="alert" className="text-sm text-destructive">{item.error}</p>
        ) : null}
        {canFallback ? (
          <div>
            <Button variant="secondary" disabled={a.busy} onClick={() => a.onGenerateAsWritten(item.id)}>
              按原文直接生成 · {cost}
            </Button>
          </div>
        ) : null}
      </MessageContent>
    </Message>
  )
}

export function ThreadItemView({ item, a }: { item: ThreadItem; a: ThreadActions }) {
  if (item.type === 'user') {
    return (
      <Message align="end">
        <MessageContent>
          {item.reference?.preview ? (
            <img src={item.reference.preview} alt="参考图" className="size-20 self-end rounded-lg object-cover" />
          ) : null}
          <Bubble variant="muted" align="end" className="jl-user-bubble">
            <BubbleContent className="whitespace-pre-wrap px-3 py-2 leading-relaxed">{item.text}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    )
  }
  if (item.type === 'assistant') return <AssistantMessage item={item} a={a} />
  if (item.type === 'job') {
    return (
      <Message align="start" className="jl-ai-message">
        <Avatar />
        <MessageContent>
          <div className="jl-job-message">
            <JobCard item={item} onRebindReference={a.onRebindReference ? (file) => a.onRebindReference!(item.id, file) : undefined} onStop={() => a.onStop(item.id)} onRetryPoll={() => a.onRetryPoll(item.id)} onRetryGeneration={() => a.onRetryGeneration(item.id)} onOpen={a.onOpen} onEdit={a.onEdit} />
          </div>
        </MessageContent>
      </Message>
    )
  }
  return <p className="text-center text-xs text-muted-foreground">{item.text}</p>
}
