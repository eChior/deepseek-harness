import { describe, expect, it } from 'vitest'
import { RedactionMap } from '../src/index.ts'

describe('RedactionMap', () => {
  it('hands the same value the same placeholder', () => {
    const map = new RedactionMap()
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-014')).toBe('[偏差-1]')
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-014')).toBe('[偏差-1]')
    expect(map.size).toBe(1)
  })

  it('numbers each category independently', () => {
    const map = new RedactionMap()
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-014')).toBe('[偏差-1]')
    expect(map.placeholder('identifier', '编号', 'SOP-ST-AD-001')).toBe('[编号-1]')
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-015')).toBe('[偏差-2]')
  })

  it('looks an issued placeholder back up', () => {
    const map = new RedactionMap()
    map.placeholder('person', '人员', '张三')
    expect(map.lookup('[人员-1]')).toBe('张三')
    expect(map.lookup('[人员-9]')).toBeUndefined()
  })

  it('restores every placeholder it issued', () => {
    const map = new RedactionMap()
    map.placeholder('person', '人员', '张三')
    map.placeholder('deviation', '偏差', 'DEV-2026-014')
    expect(map.restore('[人员-1] 负责的 [偏差-1] 已闭环')).toBe('张三 负责的 DEV-2026-014 已闭环')
  })

  it('leaves placeholders it never issued alone', () => {
    const map = new RedactionMap()
    map.placeholder('person', '人员', '张三')
    expect(map.restore('上一轮的 [人员-7] 与本轮的 [人员-1]')).toBe('上一轮的 [人员-7] 与本轮的 张三')
  })

  it('returns the text unchanged when nothing was ever redacted', () => {
    const map = new RedactionMap()
    expect(map.restore('没有占位符')).toBe('没有占位符')
  })

  it('exposes the entries it wrote', () => {
    const map = new RedactionMap()
    map.placeholder('deviation', '偏差', 'DEV-2026-014')
    expect(map.entries()).toEqual([{ placeholder: '[偏差-1]', category: 'deviation', original: 'DEV-2026-014' }])
  })

  it('forgets everything on clear', () => {
    const map = new RedactionMap()
    map.placeholder('deviation', '偏差', 'DEV-2026-014')
    map.clear()
    expect(map.size).toBe(0)
    expect(map.lookup('[偏差-1]')).toBeUndefined()
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-015')).toBe('[偏差-1]')
  })
})
