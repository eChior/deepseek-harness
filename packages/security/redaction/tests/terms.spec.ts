import { describe, expect, it } from 'vitest'
import { compileRules, isUsable, parseTermList } from '../src/index.ts'

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
