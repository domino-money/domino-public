import { stilled } from './stilled'

/**
 * The one door for JS animation (DESIGN-V2 §0.5, §5.4). Web Animations escape
 * the CSS stilling block, so this wrapper checks `stilled()` first: stilled,
 * it writes the final keyframe onto the element and returns null at once.
 * Nothing in V2 needs it; motion is CSS. Use `fill: 'none'` or 'backwards'
 * only: a finished animation must not hold a transform.
 */
export function animate(el: HTMLElement | SVGElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  const last = keyframes[keyframes.length - 1]
  if (stilled() || typeof el.animate !== 'function') {
    if (last) {
      for (const [property, value] of Object.entries(last)) {
        if (property === 'offset' || property === 'easing' || property === 'composite' || value == null) continue
        el.style.setProperty(property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(value))
      }
    }
    return null
  }
  return el.animate(keyframes, options)
}
