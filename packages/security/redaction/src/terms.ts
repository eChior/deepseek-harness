/**
 * Reader for the redaction term list (R1) and the compiled form the matcher uses.
 *
 * The list is maintained by hand by people who are not programmers, so it stays a
 * flat YAML subset — top-level scalars, one list of categories, two string lists
 * each — with comments allowed everywhere. A general YAML parser would add a
 * dependency for no benefit; the scanner below is the whole format.
 */

/** One category of the term list, exactly as written in the file. */
export interface RedactionCategory {
  readonly id: string
  readonly label: string
  readonly terms: readonly string[]
  readonly patterns: readonly string[]
}

/** A parsed term list. */
export interface RedactionTermList {
  readonly version: string
  readonly revision: string
  readonly categories: readonly RedactionCategory[]
  /** Department that submitted an uploaded list; absent on the published one. */
  readonly department?: string
  /** Person the submitting account belongs to; absent on the published one. */
  readonly author?: string
  /** Whether the list takes part at all. Absent reads as enabled. */
  readonly enabled?: boolean
}

/** A structural problem, reported against the line that caused it (0 = whole file). */
export interface TermListProblem {
  readonly line: number
  readonly message: string
}

/** Parsed list plus everything wrong with it; never throws. */
export interface ParsedTermList extends RedactionTermList {
  readonly problems: readonly TermListProblem[]
}

/** One matcher ready to run: a literal term or a regular expression. */
export interface RedactionRule {
  readonly category: string
  readonly label: string
  readonly kind: 'term' | 'pattern'
  /** The line from the list that produced this rule, for reporting a hit. */
  readonly source: string
  readonly regex: RegExp
}

const CATEGORY_ID = /^[a-z][a-z0-9-]*$/

/** Strip one layer of matching quotes; a capture group that did not participate reads as empty. */
function stripQuotes(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  const first = trimmed[0]
  if ((first === "'" || first === '"') && trimmed.at(-1) === first && trimmed.length > 1) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

interface MutableCategory {
  id: string
  label: string
  terms: string[]
  patterns: string[]
  readonly line: number
}

/**
 * Parse the term list, collecting structural problems instead of throwing.
 * @param text Contents of a `terms.yaml` file.
 * @returns The declared list plus every problem found; empty `problems` means usable.
 */
export function parseTermList(text: string): ParsedTermList {
  const problems: TermListProblem[] = []
  const categories: MutableCategory[] = []
  let version = ''
  let revision = ''
  let department = ''
  let author = ''
  let enabled = true
  let declared = false
  let category: MutableCategory | undefined
  let section: 'terms' | 'patterns' | undefined
  const fail = (line: number, message: string): void => {
    problems.push({ line, message })
  }

  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const line = index + 1
    const trimmed = raw.trimStart()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    let match = /^  - id:\s*(.*)$/.exec(raw)
    if (match !== null) {
      category = { id: stripQuotes(match[1]), label: '', terms: [], patterns: [], line }
      categories.push(category)
      section = undefined
      continue
    }
    match = /^    label:\s*(.*)$/.exec(raw)
    if (match !== null) {
      if (category === undefined) fail(line, 'label outside a category')
      else category.label = stripQuotes(match[1])
      continue
    }
    match = /^    (terms|patterns):\s*(\[\])?\s*$/.exec(raw)
    if (match !== null) {
      if (category === undefined) fail(line, `${match[1]} outside a category`)
      else section = match[1] as 'terms' | 'patterns'
      continue
    }
    match = /^      - (.*)$/.exec(raw)
    if (match !== null) {
      if (category === undefined || section === undefined) {
        fail(line, 'list entry outside a terms/patterns section')
        continue
      }
      const value = stripQuotes(match[1])
      if (section === 'patterns') {
        try {
          new RegExp(value)
        } catch (error) {
          fail(line, `pattern does not compile: ${error instanceof Error ? error.message : String(error)}`)
        }
        category.patterns.push(value)
      } else {
        if (value === '') fail(line, 'empty term')
        else if (value !== value.trim()) fail(line, 'term has leading or trailing whitespace')
        category.terms.push(value)
      }
      continue
    }
    if (/^categories:\s*(\[\])?\s*$/.test(raw)) continue
    match = /^version:\s*(.*)$/.exec(raw)
    if (match !== null) {
      version = stripQuotes(match[1])
      continue
    }
    match = /^revision:\s*(.*)$/.exec(raw)
    if (match !== null) {
      revision = stripQuotes(match[1])
      continue
    }
    match = /^department:\s*(.*)$/.exec(raw)
    if (match !== null) {
      department = stripQuotes(match[1])
      continue
    }
    match = /^author:\s*(.*)$/.exec(raw)
    if (match !== null) {
      author = stripQuotes(match[1])
      continue
    }
    match = /^enabled:\s*(.*)$/.exec(raw)
    if (match !== null) {
      const value = stripQuotes(match[1]).toLowerCase()
      if (value !== 'true' && value !== 'false') fail(line, `enabled must be true or false, not "${value}"`)
      else {
        enabled = value === 'true'
        declared = true
      }
      continue
    }
    fail(line, `unrecognized line: ${trimmed}`)
  }

  const seen = new Set<string>()
  for (const entry of categories) {
    if (entry.id === '') fail(entry.line, 'category without id')
    else if (!CATEGORY_ID.test(entry.id)) fail(entry.line, `category id "${entry.id}" must match ${CATEGORY_ID}`)
    else if (seen.has(entry.id)) fail(entry.line, `duplicate category id "${entry.id}"`)
    seen.add(entry.id)
    if (entry.label === '') fail(entry.line, `category "${entry.id}" has no label`)
    if (entry.terms.length === 0 && entry.patterns.length === 0) {
      fail(entry.line, `category "${entry.id}" matches nothing`)
    }
  }
  if (version === '') fail(0, 'missing top-level `version`')
  if (revision === '') fail(0, 'missing top-level `revision`')

  return {
    version,
    revision,
    categories,
    ...department === '' ? {} : { department },
    ...author === '' ? {} : { author },
    ...declared ? { enabled } : {},
    problems,
  }
}

/**
 * True when nothing is wrong; the caller can then trust `compileRules`.
 * @param parsed Result of {@link parseTermList}.
 * @returns True when the list carries at least one category and no problems.
 */
export function isUsable(parsed: ParsedTermList): boolean {
  return parsed.problems.length === 0 && parsed.categories.length > 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile the list into matchers. Terms become literal global expressions, patterns
 * are used as written; both are flagged global so the caller can iterate matches.
 * A pattern that fails to compile is skipped — `parseTermList` already reported it.
 * @param list Parsed list to compile.
 * @returns One matcher per term and per compilable pattern.
 */
export function compileRules(list: RedactionTermList): RedactionRule[] {
  const rules: RedactionRule[] = []
  for (const category of list.categories) {
    for (const term of category.terms) {
      rules.push({
        category: category.id,
        label: category.label,
        kind: 'term',
        source: term,
        regex: new RegExp(escapeRegExp(term), 'g'),
      })
    }
    for (const pattern of category.patterns) {
      let regex: RegExp
      try {
        regex = new RegExp(pattern, 'g')
      } catch {
        continue
      }
      rules.push({ category: category.id, label: category.label, kind: 'pattern', source: pattern, regex })
    }
  }
  return rules
}
