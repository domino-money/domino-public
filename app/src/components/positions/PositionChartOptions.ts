import { createContext, useContext } from 'react'

/** Display preferences shared by the two mounted workspace charts; no data or reads. */
export const PositionChartOptions = createContext({ expanded: false, showPoints: false })
export const usePositionChartOptions = () => useContext(PositionChartOptions)
/** A chart's plot height (design px): its compact one, or expanded its own larger one (the approved .an[data-big]). */
export const positionPlotHeight = (compact: number, phone: boolean, expanded: boolean, big: number = phone ? 280 : 320) => expanded ? big : compact
