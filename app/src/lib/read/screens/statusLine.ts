import type { ScreenText } from './copy'

/**
 * How a read went, in a read screen's words: its closed code, a title and a
 * detail, and whether asking again could help. A screen keeps it for titles,
 * data attributes and live regions; none shows it as a panel.
 */
export type StatusLine = Pick<ScreenText, 'code' | 'title' | 'detail'> & { retry?: boolean }
