import { positionPlotHeight } from '../PositionChartOptions'

/**
 * The plot's room. Desktop: the y labels and the last-value chip in a gutter
 * at the right, the dates under the plot. Phone: no
 * gutter (§13.2, padding right 8): the y labels sit inside the plot and the
 * chip rides above the end dot, in the room left at the top.
 */
export const PAD = { top: 16, right: 72, bottom: 40, left: 0 }
export const PAD_PHONE = { top: 32, right: 8, bottom: 40, left: 0 }
export const HEIGHT = 164
export const HEIGHT_PHONE = 148
/** The drawn chart's whole box, which its skeleton and its quiet plot keep (2026-09-27: nothing moves when it arrives). */
export const feesChartBox = (phone: boolean, expanded: boolean) => positionPlotHeight(phone ? HEIGHT_PHONE : HEIGHT, phone, expanded) + (phone ? PAD_PHONE.top + PAD_PHONE.bottom : PAD.top + PAD.bottom)
