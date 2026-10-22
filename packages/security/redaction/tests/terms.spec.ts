import { describe, expect, it } from 'vitest'
import { compileRules, isUsable, parseTermList } from '../src/index.ts'

/** The identity-card shape the shipped list carries; written out so a change to it fails here. */
const PERSON_PATTERN = '(?<!\\d)[1-8]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx](?![\\dXx])'

const TERMS = [
  'version: 1',
  "revision: '2026-10-15'",
  '',
  'categories:',
  '  # a comment between categories',
  '  - id: craft',
  '    label: 工艺',
  '    terms:',
  '      - 工艺规程',
  '      - 收率',
  '    patterns:',
  "      - '收率[:：]?\\d+%'",
  '  - id: person',
  '    label: 人员',
  '    terms: []',
  '    patterns:',
  "      - '\\d{17}[\\dXx]'",
].join('\n')

describe('parseTermList', () => {
  it('reads the scalars, categories, terms and patterns', () => {
    const parsed = parseTermList(TERMS)
    expect(parsed.problems).toEqual([])
    expect(parsed.version).toBe('1')
    expect(parsed.revision).toBe('2026-10-15')
    expect(parsed.categories.map(entry => entry.id)).toEqual(['craft', 'person'])
    expect(parsed.categories[0]?.label).toBe('工艺')
    expect(parsed.categories[0]?.terms).toEqual(['工艺规程', '收率'])
    expect(parsed.categories[0]?.patterns).toEqual(['收率[:：]?\\d+%'])
    expect(parsed.categories[1]?.terms).toEqual([])
  })

  it('reports an unrecognized line against its line number', () => {
    const parsed = parseTermList(['version: 1', "revision: '1'", '', 'categories:', 'nonsense: yes'].join('\n'))
    expect(parsed.problems).toEqual([{ line: 5, message: 'unrecognized line: nonsense: yes' }])
    expect(isUsable(parsed)).toBe(false)
  })

  it('reports a pattern that does not compile but keeps the rest', () => {
    const parsed = parseTermList([
      'version: 1',
      "revision: '1'",
      'categories:',
      '  - id: craft',
      '    label: 工艺',
      '    terms:',
      '      - 工艺规程',
      '    patterns:',
      "      - '(['",
    ].join('\n'))
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0]?.line).toBe(9)
    expect(parsed.problems[0]?.message).toContain('pattern does not compile')
    expect(parsed.categories[0]?.terms).toEqual(['工艺规程'])
  })

  it('reports a duplicate id, a missing label and a category that matches nothing', () => {
    const parsed = parseTermList([
      'version: 1',
      "revision: '1'",
      'categories:',
      '  - id: craft',
      '    label: 工艺',
      '    terms: []',
      '    patterns: []',
      '  - id: craft',
      '    label: 工艺',
      '    terms:',
      '      - 工艺规程',
    ].join('\n'))
    expect(parsed.problems.map(problem => problem.message)).toEqual([
      'category "craft" matches nothing',
      'duplicate category id "craft"',
    ])
  })

  it('reports missing top-level scalars against the whole file', () => {
    const parsed = parseTermList(['categories:', '  - id: craft', '    label: 工艺', '    terms:', '      - 工艺规程'].join('\n'))
    expect(parsed.problems).toEqual([
      { line: 0, message: 'missing top-level `version`' },
      { line: 0, message: 'missing top-level `revision`' },
    ])
  })
})

describe('compileRules', () => {
  it('escapes terms and keeps patterns as written', () => {
    const rules = compileRules(parseTermList(TERMS))
    expect(rules.map(rule => [rule.kind, rule.source])).toEqual([
      ['term', '工艺规程'],
      ['term', '收率'],
      ['pattern', '收率[:：]?\\d+%'],
      ['pattern', '\\d{17}[\\dXx]'],
    ])
    expect(rules[0]?.label).toBe('工艺')
    expect(rules[0]?.regex.source).toBe('工艺规程')
    expect(rules[0]?.regex.flags).toBe('g')
  })

  it('treats a term with regex metacharacters as literal text', () => {
    const rules = compileRules({
      version: '1',
      revision: '1',
      categories: [{ id: 'craft', label: '工艺', terms: ['收率(湿品)'], patterns: [] }],
    })
    expect(rules[0]?.regex.source).toBe('收率\\(湿品\\)')
    expect(rules[0]?.regex.test('收率(湿品)')).toBe(true)
    expect(rules[0]?.regex.test('收率湿品')).toBe(false)
  })

  it('skips a pattern that failed to compile', () => {
    const rules = compileRules({
      version: '1',
      revision: '1',
      categories: [{ id: 'craft', label: '工艺', terms: [], patterns: ['(['] }],
    })
    expect(rules).toEqual([])
  })
})

describe('fixed codes', () => {
  it('carries a category code through parsing and compilation', () => {
    const parsed = parseTermList([
      'version: 1',
      "revision: 'codes-1'",
      'categories:',
      '  - id: product',
      '    label: 产品',
      '    code: A',
      '    terms:',
      '      - 红霉素肠溶胶囊',
      '    patterns: []',
    ].join('\n'))
    expect(parsed.problems).toEqual([])
    expect(parsed.categories[0]?.code).toBe('A')
    const [rule] = compileRules(parsed)
    expect(rule?.code).toBe('A')
    expect(rule?.regex.test('红霉素肠溶胶胶囊')).toBe(false)
    expect(rule?.regex.test('红霉素肠溶胶囊')).toBe(true)
  })

  it('leaves the code off when the category declares none', () => {
    const parsed = parseTermList(TERMS)
    expect(parsed.categories.every(entry => entry.code === undefined)).toBe(true)
    expect(compileRules(parsed).every(rule => rule.code === undefined)).toBe(true)
  })

  it('rejects a code that is not 1-8 letters or digits', () => {
    const parsed = parseTermList([
      'version: 1',
      "revision: 'codes-2'",
      'categories:',
      '  - id: product',
      '    label: 产品',
      '    code: "A/B"',
      '    terms:',
      '      - 红霉素肠溶胶囊',
      '    patterns: []',
    ].join('\n'))
    expect(parsed.problems.some(problem => problem.message.includes('must be 1-8 letters or digits'))).toBe(true)
    expect(isUsable(parsed)).toBe(false)
  })

  it('reports a code outside a category', () => {
    const parsed = parseTermList([
      'version: 1',
      "revision: 'codes-3'",
      'categories:',
      '    code: Z',
      '  - id: product',
      '    label: 产品',
      '    terms:',
      '      - 红霉素',
      '    patterns: []',
    ].join('\n'))
    expect(parsed.problems.some(problem => problem.message === 'code outside a category')).toBe(true)
  })
})

describe('per-term codes', () => {
  it('parses a codes section and compiles each term with its own code', () => {
    const parsed = parseTermList([
      'version: 1',
      "revision: 'codes-4'",
      'categories:',
      '  - id: product',
      '    label: 产品',
      '    terms: []',
      '    patterns: []',
      '    codes:',
      '      - 红霉素肠溶胶囊|A',
      '      - 叶酸片|O',
    ].join('\n'))
    expect(parsed.problems).toEqual([])
    expect(parsed.categories[0]?.codeMap).toEqual({ '红霉素肠溶胶囊': 'A', '叶酸片': 'O' })
    const rules = compileRules(parsed)
    expect(rules).toHaveLength(2)
    expect(rules[0]?.code).toBe('A')
    expect(rules[1]?.code).toBe('O')
  })

  it('rejects a malformed codes entry', () => {
    const parsed = parseTermList([
      'version: 1',
      "revision: 'codes-5'",
      'categories:',
      '  - id: product',
      '    label: 产品',
      '    terms: []',
      '    patterns: []',
      '    codes:',
      '      - 红霉素肠溶胶囊',
    ].join('\n'))
    expect(parsed.problems.some(problem => problem.message.includes('`term|code`'))).toBe(true)
  })

  it('lets a codes-only category pass the matches-nothing check', () => {
    const parsed = parseTermList([
      'version: 1',
      "revision: 'codes-6'",
      'categories:',
      '  - id: product',
      '    label: 产品',
      '    terms: []',
      '    patterns: []',
      '    codes:',
      '      - 红霉素肠溶胶囊|A',
    ].join('\n'))
    expect(parsed.problems).toEqual([])
    expect(isUsable(parsed)).toBe(true)
  })
})

describe('the shipped person pattern', () => {
  it('matches a real identity card and leaves other 18-digit runs alone', () => {
    const [rule] = compileRules({ version: '1', revision: 't', categories: [{ id: 'person', label: '人员', terms: [], patterns: [PERSON_PATTERN] }] })
    const matched = (text: string): readonly string[] => [...text.matchAll(rule!.regex)].map(match => match[0])
    expect(matched('身份证 11010519900307123X 存档')).toEqual(['11010519900307123X'])
    expect(matched('证号330106199001011234')).toEqual(['330106199001011234'])
    expect(matched('人员编号 010004008000000000')).toEqual([])
    expect(matched('成本中心 000000000000004000')).toEqual([])
    expect(matched('订单 0100040080000000000000')).toEqual([])
    expect(matched('110105199013011234')).toEqual([])
  })

})
