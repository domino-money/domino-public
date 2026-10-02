/**
 * String#isWellFormed and String#toWellFormed (ES2024), installed where the engine lacks them: Safari and iOS WebViews
 * before 16.4, Chrome before 111 (2026-10-01, audit C12).
 *
 * The session contract's runtime checks every sign-in message with isWellFormed, so on those engines the wallet feature
 * used to stop before its identity feed started: no connection and no positions, though neither needs a sign-in. These
 * are the specification's own behaviour: a string is well-formed unless it holds a lone surrogate, and toWellFormed puts
 * U+FFFD in place of each one. Native methods are never replaced. False when the methods could not be installed (a
 * frozen prototype): the sign-in alone then says the browser is too old, and the wallet still connects.
 */

type Methods = { isWellFormed?: unknown; toWellFormed?: unknown }

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** Whether the code unit at `index` is a surrogate without its pair. */
function lone(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  if (isHigh(code)) return !isLow(text.charCodeAt(index + 1))
  if (isLow(code)) return !isHigh(text.charCodeAt(index - 1))
  return false
}

export function isWellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) if (lone(text, index)) return false
  return true
}

export function toWellFormed(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index++) out += lone(text, index) ? '\uFFFD' : text[index]
  return out
}

export function installWellFormed(target: Methods = String.prototype as Methods): boolean {
  const define = (name: keyof Methods, method: (text: string) => unknown) => {
    if (typeof target[name] === 'function') return
    try {
      Object.defineProperty(target, name, {
        value: function (this: unknown) {
          if (this === null || this === undefined) throw new TypeError(`String.prototype.${name} called on null or undefined`)
          return method(String(this))
        },
        writable: true,
        configurable: true,
        enumerable: false,
      })
    } catch {
      /* A frozen prototype keeps the engine as it is; the caller is told below. */
    }
  }
  define('isWellFormed', isWellFormed)
  define('toWellFormed', toWellFormed)
  return typeof target.isWellFormed === 'function' && typeof target.toWellFormed === 'function'
}
