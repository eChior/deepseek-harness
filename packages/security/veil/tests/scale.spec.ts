import { describe, expect, it } from 'vitest'
import { scaleNumbers } from '../src/redact.ts'

describe('scaleNumbers', () => {
  it('marks every quantity with the scaled value', () => {
    expect(scaleNumbers('投料量 25.5kg，温度 165℃', 0.01)).toBe('投料量 [0.26]kg，温度 [1.65]℃')
  })

  it('leaves a single digit alone', () => {
    expect(scaleNumbers('第 1 步，共 2 片', 10)).toBe('第 1 步，共 2 片')
  })

  it('does not touch a version, a date or a clock time', () => {
    expect(scaleNumbers('v1.2.3 于 2026-11-09 12:30 发布', 100)).toBe('v1.2.3 于 2026-11-09 12:30 发布')
  })

  it('does not scale a value it already marked', () => {
    expect(scaleNumbers('[0.26]kg 与 [1.65]℃', 10)).toBe('[0.26]kg 与 [1.65]℃')
  })

  it('is a no-op at one', () => {
    expect(scaleNumbers('投料量 25.5kg', 1)).toBe('投料量 25.5kg')
  })

  it('keeps an identifier whole', () => {
    expect(scaleNumbers('SMP-IT-009-01 与 20261022', 0.5)).toBe('SMP-IT-009-01 与 [10130511]')
  })

  it('rounds to two decimals without trailing zeros', () => {
    expect(scaleNumbers('50 和 33 和 0.5', 0.01)).toBe('[0.5] 和 [0.33] 和 [0.01]')
  })
})
