import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  BRAND_MARK_DATA_URL,
  BRAND_MARK_SIZE,
  BRAND_NAME_HEIGHT,
  BRAND_NAME_PATH,
  BRAND_NAME_VIEW_BOX,
  BRAND_NAME_WIDTH,
} from './brand-art.ts'

/**
 * Render this distribution's corporate mark at the size its host surface asks for.
 * @param props - Host-supplied mark presentation.
 * @returns the corporate mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  const edge = size > 0 ? size : BRAND_MARK_SIZE
  return (
    <img
      src={BRAND_MARK_DATA_URL}
      width={edge}
      height={edge}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

/**
 * Render the corporate short name as theme-coloured outline artwork.
 * @returns the corporate name outline.
 */
export function OfficialBrandName() {
  return (
    <svg
      width={BRAND_NAME_WIDTH}
      height={BRAND_NAME_HEIGHT}
      viewBox={BRAND_NAME_VIEW_BOX}
      fill="none"
      aria-hidden="true"
    >
      <path d={BRAND_NAME_PATH} fill="currentColor" />
    </svg>
  )
}
