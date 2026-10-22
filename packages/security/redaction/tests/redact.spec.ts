import { describe, expect, it } from 'vitest'
import { RedactionMap, codeShape, groupShape, type RedactionRule, findHits, redactText, resolveOverlaps } from '../src/index.ts'

function pattern(category: string, label: string, source: string): RedactionRule {
  return { category, label, kind: 'pattern', source, regex: new RegExp(source, 'g') }
}

function term(category: string, label: string, source: string): RedactionRule {
  return { category, label, kind: 'term', source, regex: new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') }
}

const IDENTITY = pattern('person', '人员', '\\d{17}[\\dXx]')
const MOBILE = pattern('person', '人员', '1[3-9]\\d{9}')
const DEVIATION = pattern('deviation', '偏差', '(?:DEV|CAPA)[- ]?\\d{3,}(?:-\\d{1,4})?')
const CRAFT_TERM = term('craft', '工艺', '工艺规程')
const IDENTIFIER = pattern('identifier', '编号', '(?:SOP|STP|SMP|REC)-[A-Z]{2,4}(?:-[A-Z]{2,4})*-\\d{2,4}')

describe('findHits', () => {
  it('returns every match, overlaps included', () => {
    const hits = findHits('身份证 310101199001011234', [IDENTITY, MOBILE])
    expect(hits.map(hit => hit.text).sort()).toEqual(['19900101123', '310101199001011234'])
  })

  it('ignores empty matches', () => {
    expect(findHits('abc', [pattern('craft', '工艺', 'x*')])).toEqual([])
  })

  it('records the category, label and source of each hit', () => {
    const [hit] = findHits('偏差编号 DEV-2026-014', [DEVIATION])
    expect(hit).toMatchObject({
      category: 'deviation',
      label: '偏差',
      kind: 'pattern',
      source: '(?:DEV|CAPA)[- ]?\\d{3,}(?:-\\d{1,4})?',
      text: 'DEV-2026-014',
      start: 5,
      end: 17,
    })
  })
})

describe('resolveOverlaps', () => {
  it('keeps the longest hit and drops the run of digits inside it', () => {
    const accepted = resolveOverlaps(findHits('身份证 310101199001011234', [IDENTITY, MOBILE]))
    expect(accepted.map(hit => hit.text)).toEqual(['310101199001011234'])
  })

  it('breaks a same-length tie by category priority', () => {
    const shared = 'DEV-2026-014'
    const accepted = resolveOverlaps(
      findHits(shared, [pattern('deviation', '偏差', 'DEV-2026-014'), pattern('identifier', '编号', 'DEV-2026-014')]),
    )
    expect(accepted.map(hit => hit.category)).toEqual(['identifier'])
  })

  it('falls back to the leftmost hit when lengths and ranks are equal', () => {
    const accepted = resolveOverlaps(
      findHits('aa aa', [pattern('craft', '工艺', 'aa')]),
      ['identifier'],
    )
    expect(accepted.map(hit => hit.start)).toEqual([0, 3])
  })

  it('returns hits ordered left to right', () => {
    const accepted = resolveOverlaps(findHits('DEV-2026-014 与 SOP-ST-AD-001', [DEVIATION, IDENTIFIER]))
    expect(accepted.map(hit => hit.start)).toEqual([...accepted.map(hit => hit.start)].sort((a, b) => a - b))
    expect(accepted).toHaveLength(2)
  })
})

describe('redactText', () => {
  it('replaces terms and patterns and leaves the rest alone', () => {
    const map = new RedactionMap()
    const result = redactText('按照 工艺规程 与 SOP-ST-AD-001 执行', [CRAFT_TERM, IDENTIFIER], map)
    expect(result.text).toBe('按照 [工艺-1] 与 [编号-1] 执行')
    expect(result.hits).toHaveLength(2)
    expect(result.placeholders).toEqual(['[工艺-1]', '[编号-1]'])
  })

  it('gives one value one placeholder across separate calls', () => {
    const map = new RedactionMap()
    const first = redactText('DEV-2026-014 上报了吗', [DEVIATION], map)
    const second = redactText('DEV-2026-014 已经闭环', [DEVIATION], map)
    expect(first.text).toBe('[偏差-1] 上报了吗')
    expect(second.text).toBe('[偏差-1] 已经闭环')
  })

  it('numbers distinct values per category', () => {
    const map = new RedactionMap()
    const result = redactText('DEV-2026-014 和 DEV-2026-015，还有 SOP-ST-AD-001', [DEVIATION, IDENTIFIER], map)
    expect(result.text).toBe('[偏差-1] 和 [偏差-2]，还有 [编号-1]')
  })

  it('never emits a placeholder for a run of digits inside a longer identifier', () => {
    const map = new RedactionMap()
    const result = redactText('身份证 310101199001011234，手机 13812345678', [IDENTITY, MOBILE], map)
    expect(result.text).toBe('身份证 [人员-1]，手机 [人员-2]')
  })

  it('returns the text untouched when nothing matches', () => {
    const map = new RedactionMap()
    const result = redactText('请问研发部门怎么申请会议室？', [DEVIATION, IDENTIFIER], map)
    expect(result.text).toBe('请问研发部门怎么申请会议室？')
    expect(result.hits).toEqual([])
    expect(map.size).toBe(0)
  })

  it('is idempotent: redacting its own output adds nothing', () => {
    const map = new RedactionMap()
    const once = redactText('SOP-ST-AD-001 已归档', [IDENTIFIER], map)
    const twice = redactText(once.text, [IDENTIFIER], map)
    expect(twice.text).toBe(once.text)
    expect(twice.hits).toEqual([])
  })
})

describe('fixed codes', () => {
  it('replaces every hit with the wrapped code and records the bare pairing', () => {
    const map = new RedactionMap()
    const rule = { ...term('product', '产品', '红霉素肠溶胶囊'), code: 'A' }
    const text = '红霉素肠溶胶囊与红霉素肠溶胶囊的差异'
    const result = redactText(text, [rule], map)
    // The code carries invisible separators, so the letter `A` in prose never
    // collides with it.
    expect(result.text).toBe(`${codeShape('A')}与${codeShape('A')}的差异`)
    expect(result.placeholders).toEqual([codeShape('A'), codeShape('A')])
    const [entry] = map.entries()
    expect(entry).toEqual({ placeholder: 'A', category: 'product', original: '红霉素肠溶胶囊' })
    expect(map.restore(result.text)).toBe(text)
  })

  it('leaves a natural letter in the text alone during restore', () => {
    const map = new RedactionMap()
    const rule = { ...term('product', '产品', '红霉素肠溶胶囊'), code: 'A' }
    const redacted = redactText('红霉素肠溶胶囊', [rule], map).text
    expect(map.restore(`方案${redacted}优于B方案`)).toBe('方案红霉素肠溶胶囊优于B方案')
  })

  it('keeps numbered placeholders when the rule carries no code', () => {
    const map = new RedactionMap()
    const result = redactText('红霉素肠溶胶囊', [term('product', '产品', '红霉素肠溶胶囊')], map)
    expect(result.text).toBe('[产品-1]')
  })
})

describe('alias groups', () => {
  const ZY = [
    { ...term('holder', '公司', '浙江华润三九众益制药有限公司'), code: '1.1', group: 'holder\u00001' },
    { ...term('holder', '公司', '众益'), code: '1.8', group: 'holder\u00001' },
  ]
  const SF = [{ ...term('holder', '公司', '顺峰'), code: '2.4', group: 'holder\u00002' }]

  it('gives one company one group number and one spelling per wording', () => {
    const map = new RedactionMap()
    const result = redactText('浙江华润三九众益制药有限公司由众益代持', ZY, map)
    expect(result.text).toBe(`${groupShape('公司', 1, 1)}由${groupShape('公司', 1, 2)}代持`)
    expect(result.placeholders).toEqual([groupShape('公司', 1, 1), groupShape('公司', 1, 2)])
  })

  it('keeps the same spelling on the same numbers across calls', () => {
    const map = new RedactionMap()
    redactText('众益的通知', ZY, map)
    // `众益` took 1-1 on its first sighting; the longer spelling takes the next
    // free spelling number of the same group on its own first sighting.
    const again = redactText('浙江华润三九众益制药有限公司与顺峰开会', [...ZY, ...SF], map)
    expect(again.text).toBe(`${groupShape('公司', 1, 2)}与${groupShape('公司', 2, 1)}开会`)
  })

  it('restores every spelling back to its original wording', () => {
    const map = new RedactionMap()
    const text = '浙江华润三九众益制药有限公司审核，顺峰与百诺会签'
    const rules = [...ZY, ...SF, { ...term('holder', '公司', '百诺'), code: '3.4', group: 'holder\u00003' }]
    const redacted = redactText(text, rules, map).text
    expect(map.restore(redacted)).toBe(text)
  })
})
