import { describe, expect, it } from 'vitest'
import { RedactionMap } from '../src/index.ts'

describe('RedactionMap', () => {
  it('hands the same value the same placeholder', () => {
    const map = new RedactionMap()
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-014')).toBe('[偏差-1]')
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-014')).toBe('[偏差-1]')
    expect(map.size).toBe(1)
  })

  it('numbers each label independently', () => {
    const map = new RedactionMap()
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-014')).toBe('[偏差-1]')
    expect(map.placeholder('identifier', '编号', 'SOP-ST-AD-001')).toBe('[编号-1]')
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-015')).toBe('[偏差-2]')
  })

  it('keeps one counter per visible label, not per category id', () => {
    // Two categories that read the same in a transcript share one label; a
    // counter per id would hand out the same placeholder for different values
    // and no restore tool could tell them apart.
    const map = new RedactionMap()
    expect(map.placeholder('craft', '工艺', '工艺规程')).toBe('[工艺-1]')
    expect(map.placeholder('craft-metric', '工艺', '热封温度')).toBe('[工艺-2]')
    expect(map.restore('[工艺-1] 与 [工艺-2]')).toBe('工艺规程 与 热封温度')
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

  it('files what an earlier process recorded into the machine-wide table', () => {
    // A placeholder outlives the process that issued it: the session file keeps
    // it forever, so the map has to hand a reader the file's own table.
    const map = new RedactionMap()
    map.adopt([{ placeholder: '[偏差-4]', category: 'deviation', original: 'DEV-2026-004' }])
    expect(map.entries()).toEqual([{ placeholder: '[偏差-4]', category: 'deviation', original: 'DEV-2026-004' }])
    expect(map.restore('[偏差-4] 已闭环')).toBe('DEV-2026-004 已闭环')
    // The live log stays what this process wrote itself, so the writer never
    // files the same pairing twice and the count a reader sees stays its own.
    expect(map.liveEntries()).toEqual([])
    expect(map.size).toBe(0)
  })

  it('never reuses a number an earlier process already gave out', () => {
    const map = new RedactionMap()
    map.adopt([{ placeholder: '[偏差-4]', category: 'deviation', original: 'DEV-2026-004' }])
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-099')).toBe('[偏差-5]')
  })

  it('keeps the number a mapping file pinned to a value', () => {
    // Without this a value first seen after a restart takes a fresh number and
    // yesterday's sessions stop restoring.
    const map = new RedactionMap()
    map.adopt([{ placeholder: '[偏差-4]', category: 'deviation', original: 'DEV-2026-004' }])
    expect(map.placeholder('deviation', '偏差', 'DEV-2026-004')).toBe('[偏差-4]')
    expect(map.size).toBe(0)
  })

  it('returns the filed table and the live work in one list', () => {
    const map = new RedactionMap()
    map.adopt([{ placeholder: '[偏差-4]', category: 'deviation', original: 'DEV-2026-004' }])
    map.placeholder('deviation', '偏差', 'DEV-2026-099')
    expect(map.entries().map(entry => entry.placeholder)).toEqual(['[偏差-4]', '[偏差-5]'])
    expect(map.liveEntries().map(entry => entry.placeholder)).toEqual(['[偏差-5]'])
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
