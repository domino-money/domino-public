import { createContext, useContext } from 'react'

/** Display preferences shared by the two mounted workspace charts; no data or reads. */
export const PositionChartOptions = createContext({ expanded: false, showPoints: false })
export const usePositionChartOptions = () => useContext(PositionChartOptions)
export const positionPlotHeight = (compact: number, phone: boolean, expanded: boolean) => expanded ? (phone ? 280 : 320) : compact
