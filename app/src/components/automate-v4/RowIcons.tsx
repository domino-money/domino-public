/*
 * The two small marks of Automate's rows, drawn as the owner's approved site/automate.html draws them: the row action's
 * chevron (.act svg, 14px on a 16 grid) and How it works' open book (.how svg, 14px on a 14 grid). Decoration only
 * (aria-hidden); v4-automate.css sizes them (0.875rem) and gives them their hover motion.
 */
export function ActChevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function HowBook() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <path d="M7 3.6C5.6 2.6 3.7 2.4 1.75 3v7.9c1.95-.6 3.85-.4 5.25.6 1.4-1 3.3-1.2 5.25-.6V3C10.3 2.4 8.4 2.6 7 3.6Zm0 0v7.9" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  )
}
