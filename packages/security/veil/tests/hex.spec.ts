import { describe, expect, it } from 'vitest'
import { RedactionMap, type RedactionRule, redactText } from '../src/index.ts'

/**
 * A term rule the way the compiler builds one from a term list.
 * @param category - the term category id.
 * @param label - the label a placeholder carries.
 * @param source - the literal the rule matches.
 * @returns the rule.
 */
function term(category: string, label: string, source: string): RedactionRule {
  return { category, label, kind: 'term', source, regex: new RegExp(source, 'g') }
}

const COMPANY = term('holder', '公司', '示例制药有限公司')
const RULES = [COMPANY]

/**
 * The bytes of a text, rendered the way a hex view renders them.
 * @param text - the text to dump.
 * @param separator - what goes between the bytes.
 * @returns the dump.
 */
function dump(text: string, separator: string): string {
  return Array.from(Buffer.from(text, 'utf8'))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join(separator)
}

describe('a byte dump', () => {
  it('is read as the text it stands for', () => {
    const { text } = redactText(dump('示例制药有限公司', ' '), RULES, new RedactionMap())
    expect(text).toBe('[公司-1]')
  })

  it('is read with its separators stripped', () => {
    const { text } = redactText(`bytes ${dump('示例制药有限公司', ':')} end`, RULES, new RedactionMap())
    expect(text).toBe('bytes [公司-1] end')
  })

  it('is read when the dump has no separators at all', () => {
    const { text } = redactText(dump('示例制药有限公司', ''), RULES, new RedactionMap())
    expect(text).toBe('[公司-1]')
  })

  it('keeps the same placeholder as the text it came from', () => {
    const map = new RedactionMap()
    const first = redactText('示例制药有限公司', RULES, map).text
    const second = redactText(dump('示例制药有限公司', ' '), RULES, map).text
    expect(second).toBe(first)
  })

  it('leaves a hash alone', () => {
    const hash = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
    const { text } = redactText(hash, RULES, new RedactionMap())
    expect(text).toBe(hash)
  })

  it('leaves an ordinary answer alone', () => {
    const answer = 'The build finished in 621ms and wrote 3 files.'
    const { text } = redactText(answer, RULES, new RedactionMap())
    expect(text).toBe(answer)
  })
})
