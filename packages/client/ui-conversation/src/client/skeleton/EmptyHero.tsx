// The composer remains in ConversationRoot so switching out of the blank-draft
// phase does not remount its textarea.

import type { ReactNode, RefObject } from 'react'
import {
  IconChevronDownOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { ConversationContentProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationContentProps['t']

/**
 * Basename label for the workspace chip (the shared derivation);
 * separator-only paths echo the raw cwd.
 * @param cwd - workspace directory path (non-empty).
 * @returns chip label.
 */
export function workspaceLabel(cwd: string): string {
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * The workspace chip (folder + label + chevron), always interactive: before
 * the first message the workspace stays switchable — picking another one
 * moves the New Session flow to that workspace's blank session. Without a
 * label the chip renders its placeholder state: closed folder + the
 * "Choose workspace" call to action.
 * @param props.label - chip label (see {@link workspaceLabel}); omitted → placeholder.
 * @param props.menuOpen - menu expansion echo.
 * @param props.onClick - menu toggle.
 * @returns the chip button element.
 */
export function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label?: string | undefined
  menuOpen?: boolean
  onClick?: () => void
  t: HeroTranslate
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.workspace}
      aria-label={t('hero.chooseWorkspace')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={onClick}
    >
      {label === undefined
        ? <IconFolderCloseRegular className={css.folder} size={16} />
        : <IconFolderOpenRegular className={css.folder} size={16} />}
      <span className={css.workspaceLabel}>{label ?? t('hero.chooseWorkspace')}</span>
      <IconChevronDownOutlineRegular className={css.chevron} size={12} />
    </button>
  )
}

/** Hero chrome props. The workspace row rides the InputBar accessory hole, not here. */
export interface HeroShellProps {
  /** The owner's locale seat, passed down as a plain prop. */
  t: HeroTranslate
  /** Authorized renderer for the hero brand-mark slot. */
  renderSlot: ConversationContentProps['renderSlot']
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}

/** The hero mark's artwork: the 益 sign on the 1024 canvas the brand files ship. */
const HERO_MARK_VIEWBOX = 1024
/** The plate the 益 sign sits on, in the brand orange at every scale. */
const HERO_MARK_COLOR = '#F8A415'
/** The plate's corner radius, measured on the 1024 canvas the brand files ship. */
const HERO_MARK_RADIUS = 75.1
/** The sign inside the plate: white, like the icon the installer and tray use. */
const HERO_MARK_GLYPH = '#FFFFFF'

const HERO_MARK_PATH =
  'M295.72 175.33 C281.08 176.16 272.61 179.2 278.75 181.42 C307.67 191.89 322.53 206.94 339.56 243.01 C356.53 278.97 374.78 288.72 425.07 288.72 C457.3 288.72 463.26 283.66 457.37 261.3 C442.67 205.6 377.13 170.74 295.72 175.33 M727.23 175.77 C677.13 182.78 653.17 196.1 622.24 234.13 C613.18 245.27 612.4 246.18 606.61 252.57 C592.48 268.15 574.91 279.88 556.6 285.95 C552.83 287.19 549.91 288.36 550.09 288.55 C550.79 289.25 649.62 288.68 655.84 287.94 C688.89 284.03 708.12 269.25 726.15 233.91 C740.4 205.98 751.91 192.64 769.35 183.84 C775.72 180.63 775.72 178.59 769.36 176.72 C766.5 175.88 732.01 175.1 727.23 175.77 M222.23 306.64 C215.45 308.44 209.81 313.17 206.05 320.24 C203.49 325.03 203.46 358.59 206 363.75 C208.06 367.94 212.44 372.32 216.95 374.7L220.48 376.56 514.08 376.74 C840.4 376.94 811.16 377.37 817.78 372.31 C826.38 365.72 828.29 358.89 828.35 334.48 C828.39 316.72 822.82 308.4 809.47 306.26 C801.49 304.98 227.07 305.35 222.23 306.64 M384.96 395.08 C377.36 397.09 372.11 400.69 360.51 411.87 C305.13 465.22 250.36 505.77 197.95 532.22 C177.9 542.34 178.08 549.12 198.55 554.66 C251.12 568.88 336.25 529.95 410.42 457.78 C445.56 423.58 454.75 405.07 440.87 396.45L438.16 394.76 412.61 394.64 C398.56 394.58 386.12 394.77 384.96 395.08 M620.84 395.46 C608.9 399.69 609.98 406.68 625.09 422.81 C634.3 432.65 634.07 431.84 628.71 435.71 C626.31 437.44 615.84 445.31 605.44 453.21 C561.92 486.24 554.97 491.22 552.88 490.82 C552.05 490.66 547.12 487.91 541.92 484.71L532.47 478.89 532.14 474.27 C530.03 444.92 485.41 445.94 485.32 475.35 C485.25 498.52 513.93 508.02 527.4 489.28 C529.8 485.94 527.55 484.84 548.33 499.46 C557.55 505.94 554.88 507.11 586.97 482.6 C605.95 468.12 611.29 464.02 631.48 448.5L640.72 441.39 651.1 450.98 C656.81 456.24 664.31 463.12 667.76 466.26 C674.69 472.57 703.42 497.1 707.27 500.01 C708.62 501.02 712.74 504.27 716.44 507.22 C745.9 530.74 780.33 552.61 791.44 554.87 C811.84 559.01 838.24 529.46 829.6 512.15 C827.09 507.13 823.54 504.05 802.82 488.92 C796.28 484.14 786.08 476.59 780.15 472.14 C774.23 467.69 767.92 462.95 766.12 461.6 C764.33 460.26 759.45 456.48 755.29 453.21 C751.12 449.93 746.39 446.31 744.77 445.16 C743.15 444 733.07 436.28 722.38 428.01 C692.6 404.96 682.5 398.51 671.94 395.81 C664.87 394 625.73 393.73 620.84 395.46 M351.39 533.78 C316.73 538.83 295.56 564.87 291.48 607.52 C290.7 615.62 289.31 629.64 288.38 638.69 C287.46 647.73 285.75 664.43 284.58 675.78 C283.42 687.14 282.12 699.9 281.69 704.13 C278.62 734.37 277.65 738.56 272.2 745.04 C266.45 751.88 265.07 752.08 223.8 752.08 C182.94 752.08 183.53 752 177.65 758.03 C172.92 762.89 172.23 765.4 172.78 775.91 C174.24 803.8 189.32 823.91 212.43 828.81 C220.32 830.48 807.68 830.47 815.66 828.8 C838.58 823.99 853.25 801.91 853.74 771.5 C853.88 762.21 851.52 757.55 844.82 753.94 C842.07 752.46 841.28 752.42 804.16 752.08L766.3 751.73 763.4 749.71 C755.59 744.3 755.49 741.87 760.84 691.53 C762.96 671.51 765.18 650.57 765.76 644.99 C766.33 639.41 767.46 629.01 768.27 621.89 C773.64 574.13 749.35 540.88 704.12 534.06 C696.17 532.86 359.53 532.59 351.39 533.78 M393.71 593.87 C386.44 594.81 379.99 598.91 375.56 605.4 C371.8 610.91 371.11 614.53 368.86 640.79 C368.25 647.91 366.99 660.67 366.07 669.13 C365.15 677.6 363.57 692.72 362.56 702.73 C361.56 712.74 360.28 725.02 359.73 730.03 C357.19 752.9 356.08 752.08 389.46 752.08 C420.69 752.08 418 753.68 420.31 733.63 C421.66 721.93 426.57 674.51 429.41 645.69 C430.19 637.8 431.14 628.25 431.52 624.48 C433.07 609.05 435.56 607.89 466.99 607.89 C498.59 607.9 501.16 609.33 499.45 625.91 C499.06 629.67 498.26 637.54 497.67 643.41 C497.08 649.28 496.12 658.89 495.52 664.76 C494.93 670.63 493.67 683.15 492.71 692.58 C491.76 702.01 490.2 717.08 489.24 726.05 C487.03 746.85 487.02 748.16 489.22 750.36L490.94 752.08 514.67 752.08 C544.11 752.08 542.55 752.78 544.14 738.78 C544.51 735.51 546.25 720.54 548.01 705.53 C549.77 690.52 551.52 675.4 551.9 671.93 C557.53 620.55 558.48 615.23 562.72 611.5 C566.38 608.29 566.85 608.24 593.6 608.24L618.15 608.24 620.78 610.25 C627.3 615.22 627.29 611.67 620.85 663.81 C609.56 755.2 610.27 746.87 613.48 750.07L615.56 752.16 634.65 751.94 C655.96 751.7 657.04 751.48 663.57 746.13 C671.71 739.47 673.66 733.69 676.12 709.03 C676.74 702.87 679.15 680.98 681.47 660.39 C686.58 615.22 686.64 613.84 683.6 607.68 C677.84 595.97 673.5 594.35 646.39 593.84 C615.55 593.25 398.28 593.28 393.71 593.87'

/**
 * The hero mark (30px), static at rest. Hovering sways it in place through
 * CSS on the hitbox; the artwork never morphs, so the mark stays this
 * distribution's own sign instead of the upstream whale. Decorative — hidden
 * from the accessibility tree.
 * @returns the hero mark svg element.
 */
function HeroMark() {
  return (
    <svg
      className={css.fish}
      width={30}
      height={30}
      viewBox={`0 0 ${HERO_MARK_VIEWBOX} ${HERO_MARK_VIEWBOX}`}
      fill="none"
      aria-hidden="true"
    >
      <rect
        width={HERO_MARK_VIEWBOX}
        height={HERO_MARK_VIEWBOX}
        rx={HERO_MARK_RADIUS}
        fill={HERO_MARK_COLOR}
      />
      <path d={HERO_MARK_PATH} fill={HERO_MARK_GLYPH} fillRule="evenodd" />
    </svg>
  )
}

/**
 * Render the hero chrome (headline only; no composer, no workspace row).
 * @param props - see {@link HeroShellProps}.
 * @returns the centered hero element tree.
 */
export function HeroShell({ t, renderSlot, children }: HeroShellProps) {
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          {/* figma 34:10412: the mark leads the headline, gap 10. */}
          <span className={css.fishHitbox}>
            {renderSlot('conversation.hero.brand.mark', { size: 34, className: css.fish }, {
              fallback: <HeroMark />,
            })}
          </span>
          <span className={css.titleGroup}>
            {/* Own element: keeps the headline text addressable apart from the badge. */}
            <span>{t('hero.headline')}</span>
            <span className={css.previewBadge}>{t('hero.preview')}</span>
          </span>
        </div>
        <div className={css.body}>
          {/* The composer remains mounted outside this component. */}
        </div>
      </div>
      {children}
    </div>
  )
}
