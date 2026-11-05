import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeVision, normalizeRecognized, resolvePaddle } from '../src/vision.ts'

/**
 * A downloaded reader has to switch itself on.
 *
 * The download is an archive a person unpacks, so the only thing they can be
 * asked to do is put the file somewhere known: a directory that already holds
 * the binary must therefore be enough, and a typed path must still win.
 */
describe('resolvePaddle', () => {
  it('finds a binary that was unpacked into the download directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-'))
    const binary = join(directory, 'dsh-ocr.exe')
    writeFileSync(binary, '')
    expect(resolvePaddle('', directory)).toBe(binary)
    expect(describeVision({ paddleDirectory: directory })).toBe('paddle')
  })

  it('prefers the path a deployment typed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-'))
    writeFileSync(join(directory, 'dsh-ocr.exe'), '')
    const typed = join(directory, 'typed.exe')
    writeFileSync(typed, '')
    expect(resolvePaddle(typed, directory)).toBe(typed)
  })

  it('reports nothing when the directory holds no reader', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-'))
    expect(resolvePaddle('', directory)).toBe('')
    expect(resolvePaddle(undefined, '')).toBe('')
  })
})

/**
 * A recognizer reports one token per visual run, so the spaces it inserts carry
 * no meaning: they appear between every pair of Chinese characters and inside a
 * long number. Removing them is what makes the result matchable by the same rules
 * that match typed text, which is the only reason to read the image at all.
 */
describe('normalizeRecognized', () => {
  it('joins Chinese characters that arrived spaced apart', () => {
    expect(normalizeRecognized('华 润 三 九 众 益 制 药 有 限 公 司')).toBe('华润三九众益制药有限公司')
  })

  it('joins a number that arrived split across tokens', () => {
    expect(normalizeRecognized('联系电话 1 3800138000 联系人 张三')).toBe('联系电话13800138000联系人张三')
  })

  it('restores a hyphen read as the character that looks like one', () => {
    expect(normalizeRecognized('偏差编号 DEV 一 2026一 014 结晶温度')).toBe('偏差编号DEV-2026-014结晶温度')
  })

  it('keeps the spaces between Latin words', () => {
    expect(normalizeRecognized('CR Sanjiu supplier audit 2026')).toBe('CR Sanjiu supplier audit 2026')
  })

  it('leaves a lone Chinese character alone', () => {
    expect(normalizeRecognized('一')).toBe('一')
  })
})
