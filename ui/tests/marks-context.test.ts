import { expect, test } from 'bun:test'
import { referencePromptWithMarks, type Mark } from '../src/chat/marks'
const point: Mark = { id: 'point', type: 'point', x: .25, y: .4, w: 0, h: 0, note: ' 把这里改成红色 ' }
test('chat reference keeps the source and includes normalized point and box instructions', () => {
  const text = referencePromptWithMarks('原图描述', [point, { ...point, type: 'area', x: .5, y: .5, w: .8, h: .8, note: '背景换成黄昏' }])
  expect(text).toStartWith('原图描述')
  const annotations = JSON.parse(text.split('标记修改要求（坐标为原图的0..1比例）：\n')[1])
  expect(annotations).toEqual([{ type: 'point', x: .25, y: .4, text: '把这里改成红色' }, { type: 'box', x: .5, y: .5, w: .5, h: .5, text: '背景换成黄昏' }])
})
test('large source descriptions cannot push mark instructions beyond the server 2000-character limit', () => {
  const text = referencePromptWithMarks('🌸'.repeat(5000), Array.from({ length: 12 }, (_, index) => ({ ...point, id: String(index), note: `第${index}处：` + '\\"🌸'.repeat(250) })))
  expect(Array.from(text).length).toBeLessThanOrEqual(2000)
  const annotations = JSON.parse(text.split('标记修改要求（坐标为原图的0..1比例）：\n')[1])
  expect(annotations).toHaveLength(12)
  for (let i = 0; i < 12; i++) expect(annotations[i].text).toStartWith(`第${i}处：`)
})
test('without completed marks the reference remains unchanged except for the server budget', () => {
  expect(referencePromptWithMarks('原图描述', [{ ...point, note: '  ' }])).toBe('原图描述')
  expect(Array.from(referencePromptWithMarks('🌸'.repeat(3000), [])).length).toBe(2000)
})
