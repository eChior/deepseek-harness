import { describe, expect, it } from 'vitest'
import { DOCUMENT_EXTENSIONS, documentPaths, isDocumentPath } from '../src/documents.ts'

describe('documentPaths', () => {
  it('reads a structured path argument', () => {
    expect(documentPaths({ path: 'D:/work/report.docx' })).toEqual(['D:/work/report.docx'])
  })

  it('reads a path a shell command quotes because it holds spaces', () => {
    const command = 'python create.py "D:/DSH Work/office-test/占位符.docx"'
    expect(documentPaths({ command })).toEqual(['D:/DSH Work/office-test/占位符.docx'])
  })

  it('reads a bare path in a shell command', () => {
    expect(documentPaths({ command: 'cat notes.md | head' })).toEqual(['notes.md'])
  })

  it('ignores documents the restore pass does not handle', () => {
    expect(documentPaths({ path: 'D:/work/app.exe', command: 'python x.py out.pdf' })).toEqual([])
  })

  it('reads every document one call mentions, without repeats', () => {
    const arguments_ = { command: 'python x.py a.docx b.xlsx a.docx' }
    expect(documentPaths(arguments_).sort()).toEqual(['a.docx', 'b.xlsx'])
  })

  it('walks nested argument payloads', () => {
    expect(documentPaths({ files: [{ path: 'a.md' }], options: { out: 'b.pptx' } }).sort()).toEqual([
      'a.md',
      'b.pptx',
    ])
  })
})

describe('isDocumentPath', () => {
  it('accepts the authored formats and nothing else', () => {
    for (const path of ['a.docx', 'a.XLSX', 'a.pptx', 'a.md', 'a.txt', 'a.csv']) {
      expect(isDocumentPath(path)).toBe(true)
    }
    for (const path of ['a.pdf', 'a.exe', 'a', 'a.docx.zip']) {
      expect(isDocumentPath(path)).toBe(false)
    }
  })

  it('publishes exactly the extensions it accepts', () => {
    expect([...DOCUMENT_EXTENSIONS].sort()).toEqual([
      '.csv',
      '.docx',
      '.markdown',
      '.md',
      '.pptx',
      '.tsv',
      '.txt',
      '.xlsx',
    ])
  })
})
