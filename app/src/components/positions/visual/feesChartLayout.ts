import { positionPlotHeight } from '../PositionChartOptions'

/**
 * The plot's room. Desktop: the y labels and the last-value chip in a gutter
 * at the right, the dates under the plot. Phone: no
 * gutter (§13.2, padding right 8): the y labels sit inside the plot and the
 * chip rides above the end dot, in the room left at the top.
 */
export const PAD = { top: 16, right: 72, bottom: 30, left: 0 }
export const PAD_PHONE = { top: 32, right: 8, bottom: 30, left: 0 }
/**
 * V4 (2026-10-17, site/position.html .c-fees): the plot 248 design px tall, 368 expanded (320 on a phone), the dates in a
 * 30px row under it. A phone keeps its chip room on top, so its plot gives those 18px back: the same box.
 */
export const HEIGHT = 248
export const HEIGHT_PHONE = 230
export const BIG = 368
export const BIG_PHONE = 320
/** The dates' baseline under the plot (the kit's .xl: 10px down in its 30px row, 12px text). */
export const DATES_BELOW = 22
/** The drawn chart's whole box, which its skeleton and its quiet plot keep (2026-09-27: nothing moves when it arrives). */
export const feesChartBox = (phone: boolean, expanded: boolean) => positionPlotHeight(phone ? HEIGHT_PHONE : HEIGHT, phone, expanded, phone ? BIG_PHONE : BIG) + (phone ? PAD_PHONE.top + PAD_PHONE.bottom : PAD.top + PAD.bottom)
