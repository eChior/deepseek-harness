/** This distribution ships product telemetry off under every profile. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

it('ships both product-telemetry rows disabled under every profile', () => {
  const rows = loadOverlayPatches('analytics', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
    .filter(row => row.id === 'desktop-product-telemetry' || row.id === 'product-analytics')
  expect(rows.map(row => row.id)).toEqual(['desktop-product-telemetry', 'product-analytics'])
  for (const row of rows) expect(row.disabled).toBe(true)
})
