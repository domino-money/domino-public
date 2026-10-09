import { answerChainRoute, type ChainRouteContext } from '../../../_lib/chainRoutes'
export const onRequest = (context: ChainRouteContext) => answerChainRoute('confirmation', context)
