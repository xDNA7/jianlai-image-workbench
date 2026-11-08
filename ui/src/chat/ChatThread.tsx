import type { ReactNode } from 'react'
import { ArrowUpRightIcon, ImageIcon, ShoppingBagIcon, LayoutTemplateIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ai/message-scroller'
import { ThreadItemView } from './Thread'
import type { ThreadActions } from './Thread'
import type { ThreadItem } from './types'

/** `label` is what the chip shows; `prompt` is what is sent, written so it needs no further details. */
export const SUGGESTIONS = [
  {
    label: '新品上市海报',
    prompt: '新品上市促销海报，竖版。主体是一瓶高端护肤精华放在奶油色大理石台面上，柔和的侧光，背景留白干净，主色米白搭配松绿点缀。顶部大标题“新品上市”，副标题“首发立减50元”，底部一行小字“限时3天”，整体高级、简洁。',
  },
  {
    label: '电商主图',
    prompt: '电商商品主图，正方形。主体是一款白色无线蓝牙耳机和充电盒，居中展示，浅灰渐变背景，干净的产品投影，左上角红色圆形角标“爆款”，下方一条醒目的价格条“到手价 ¥199”，画面清爽、突出商品。',
  },
  {
    label: '课程介绍图',
    prompt: '线上课程介绍图，横版。主题是“销售话术实战营”，深绿色商务风背景，左侧大标题“销售话术实战营”，副标题“7天学会成交”，右侧是插画风的沟通场景，下方三个要点图标：“案例拆解”“模拟演练”“1对1点评”，右下角“立即报名”按钮样式。',
  },
  {
    label: '讲师介绍图',
    prompt: '讲师介绍图，竖版。一位穿深色西装、微笑自信的中年女讲师半身照，浅米色背景，左上角姓名“王老师”大字，下面一行“10年销售培训经验”，再下面三条履历要点：“服务500+企业”“培训学员2万人”“金牌讲师认证”，底部一条松绿色色块，整体专业、可信。',
  },
  {
    label: '销售活动海报',
    prompt: '门店周年庆促销海报，竖版。红金配色，喜庆但不杂乱，中间超大数字“5折”，上方标题“周年庆 感恩回馈”，下方时间“活动时间：本周六至周日”，周围有礼盒、彩带和金币装饰，底部预留二维码位置。',
  },
  {
    label: '业绩喜报',
    prompt: '销售团队业绩喜报海报，竖版。红色背景配金色烟花和飘带，中间大标题“喜报”，下方“华东大区 本月业绩突破500万”，再下面三位销售冠军的头像框和姓名“张伟 李娜 陈明”，底部一行“向每一位奋斗者致敬”，庄重热烈。',
  },
]

type Props = {
  items: ThreadItem[]
  actions: ThreadActions
  disabled: boolean
  onSuggest: (text: string) => void
  emptyComposer?: ReactNode
}

const suggestionIcons = [ImageIcon, ShoppingBagIcon, LayoutTemplateIcon]

function Welcome({ disabled, onSuggest, emptyComposer }: Pick<Props, 'disabled' | 'onSuggest' | 'emptyComposer'>) {
  return (
    <div className="jl-welcome">
      <div className="jl-welcome-inner">
        <span className="jl-welcome-eyebrow">AI 创作工作台</span>
        <h1>把想法，变成画面。</h1>
        <p className="jl-welcome-intro">描述你的想法，或上传一张参考图。我们一起把画面打磨好。</p>
        {emptyComposer}
        <div className="jl-suggestions" role="group" aria-label="试试这些">
          {SUGGESTIONS.map(({ label, prompt }, index) => {
            const Icon = suggestionIcons[index % suggestionIcons.length]
            return <Button key={label} variant="ghost" disabled={disabled} onClick={() => onSuggest(prompt)} className="jl-suggestion"><Icon aria-hidden="true" /><span>{label}</span><ArrowUpRightIcon aria-hidden="true" /></Button>
          })}
        </div>
      </div>
    </div>
  )
}

export function ChatThread({ items, actions, disabled, onSuggest, emptyComposer }: Props) {
  if (items.length === 0) return <Welcome disabled={disabled} onSuggest={onSuggest} emptyComposer={emptyComposer} />
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
            {items.map((item) => (
              <MessageScrollerItem key={item.id} messageId={item.id} scrollAnchor={item.type === 'user'} className="[content-visibility:visible]">
                <ThreadItemView item={item} a={actions} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
