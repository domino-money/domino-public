/**
 * The previews' view of the page's one session controller. Imported only by
 * the #/live-preview screen, which only the consumer-test build contains
 * (tests/consumer.guard.test.mjs). The deposit fixture lab never uses it.
 */
import { sessionController } from '../wallet/session'
import { createSessionPort } from './port'

export const livePort = createSessionPort(sessionController)
