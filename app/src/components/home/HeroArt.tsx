import { useRef, type PointerEvent } from 'react'
import '../../styles/hero-refinement.css'
import { useSvgId } from '../charts/series'
import { cx } from '../ui'
import { useInView } from './Vignettes'
import { stilled, useStilled } from '../../lib/motion/stilled'

/** A dimensional brand sculpture, with no prices, returns or simulated financial state. */
export function HeroArt({ className, running }: { className?: string; running?: boolean }) {
  const [ref, seen] = useInView<SVGSVGElement>(0.3, running === undefined)
  const spotlight = useRef<HTMLSpanElement>(null)
  const still = useStilled()
  const active = running ?? seen
  const face = useSvgId('domino-face')
  const edge = useSvgId('domino-edge')
  const glass = useSvgId('domino-glass')
  const metal = useSvgId('domino-metal')
  const glow = useSvgId('domino-ambient')
  const shade = useSvgId('domino-shadow')
  const dots = useSvgId('domino-grid')
  const clearSpotlight = () => {
    const light = spotlight.current
    if (!light) return
    delete light.dataset.active
    light.style.removeProperty('--hero-pointer-x')
    light.style.removeProperty('--hero-pointer-y')
  }
  const illuminate = (event: PointerEvent<SVGSVGElement>) => {
    const light = spotlight.current
    if (!light || event.pointerType === 'touch' || stilled()) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const percent = (position: number, start: number, length: number) => `${Math.min(100, Math.max(0, (position - start) / length * 100))}%`
    light.style.setProperty('--hero-pointer-x', percent(event.clientX, bounds.left, bounds.width))
    light.style.setProperty('--hero-pointer-y', percent(event.clientY, bounds.top, bounds.height))
    light.dataset.active = ''
  }
  return (
    <>
      <svg ref={ref} className={cx('dm-art dm-hero-art dm-hero-sculpture', active && 'is-running', className)}
        viewBox="0 0 640 480" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"
        onPointerMove={illuminate} onPointerLeave={clearSpotlight}>
        <defs>
          <linearGradient id={face} x1="0" y1="0" x2="0.85" y2="1">
            <stop offset="0" className="dm-sculpture-peach" /><stop offset="0.52" className="dm-sculpture-orange" /><stop offset="1" className="dm-sculpture-copper" />
          </linearGradient>
          <linearGradient id={edge} x1="0" y1="0" x2="1" y2="0.8">
            <stop offset="0" className="dm-sculpture-copper" /><stop offset="1" className="dm-sculpture-dark" />
          </linearGradient>
          <linearGradient id={glass} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="dm-sculpture-glass-light" /><stop offset="1" className="dm-sculpture-glass-dark" />
          </linearGradient>
          <linearGradient id={metal} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="dm-sculpture-silver" /><stop offset="1" className="dm-sculpture-silver-dark" />
          </linearGradient>
          <radialGradient id={glow}>
            <stop offset="0" className="dm-sculpture-orange" stopOpacity="0.18" /><stop offset="1" className="dm-sculpture-orange" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={shade}>
            <stop offset="0" stopColor="var(--bg)" stopOpacity="0.95" /><stop offset="1" stopColor="var(--bg)" stopOpacity="0" />
          </radialGradient>
          <pattern id={dots} width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.75" fill="var(--primary)" opacity="0.14" />
          </pattern>
        </defs>
        <ellipse cx="371" cy="272" rx="252" ry="221" fill={`url(#${glow})`} />
        <rect x="95" y="34" width="480" height="388" fill={`url(#${dots})`} opacity="0.5" />
        <ellipse cx="352" cy="414" rx="230" ry="45" fill={`url(#${shade})`} />
        <ellipse cx="335" cy="319" rx="260" ry="86" className="dm-sculpture-orbit" transform="rotate(-18 335 319)" />
        <g data-hero-play="automatic">
          <g transform="translate(90 156) rotate(-12 29 29)">
            <g className="dm-sculpture-network dm-sculpture-network-base">
              <circle cx="33" cy="35" r="29" fill="#172d65" />
              <circle cx="29" cy="29" r="29" fill="#315ee0" />
              <circle cx="29" cy="29" r="22" fill="none" stroke="#ffffff" strokeOpacity=".18" />
              <circle cx="29" cy="29" r="14" fill="#f3f4fa" /><path d="M13 29h17" stroke="#315ee0" strokeWidth="3" />
            </g>
          </g>
          <g transform="translate(535 99) rotate(13 25 25)">
            <g className="dm-sculpture-network dm-sculpture-network-arbitrum">
              <circle cx="29" cy="31" r="25" fill="#142c3f" /><circle cx="25" cy="25" r="25" fill="#315a79" />
              <path d="m25 8 15 8v18l-15 8-15-8V16Z" fill="none" stroke="#d5e3ed" strokeWidth="1.4" />
              <path d="m17 33 7-17h5l-7 17Zm12-10 6 10h-5l-3-5Z" fill="#d5e3ed" />
            </g>
          </g>
          <g transform="translate(177 114) rotate(-18 80 140)">
            <g className="dm-sculpture-rear">
              <rect x="11" y="12" width="148" height="256" rx="22" fill="var(--bg)" />
              <rect width="148" height="256" rx="22" fill={`url(#${glass})`} className="dm-sculpture-glass-rim" />
              <rect x="5" y="5" width="138" height="246" rx="18" className="dm-sculpture-inset" />
              <path d="M1 128H147" className="dm-sculpture-glass-rim" />
              <circle cx="74" cy="64" r="13" className="dm-sculpture-back-pip" />
              <circle cx="53" cy="174" r="12" className="dm-sculpture-back-pip" /><circle cx="95" cy="210" r="12" className="dm-sculpture-back-pip" />
            </g>
          </g>
          <g transform="translate(329 58) rotate(14 87 146)">
            <g className="dm-sculpture-front">
              <rect x="15" y="13" width="174" height="292" rx="25" fill={`url(#${edge})`} />
              <rect width="174" height="292" rx="25" fill={`url(#${face})`} />
              <rect x="4" y="4" width="166" height="284" rx="21" className="dm-sculpture-face-rim" />
              <path d="M1 146H173" className="dm-sculpture-divider" /><path d="M8 147H166" className="dm-sculpture-divider-light" />
              <g className="dm-sculpture-pips">
                <circle cx="60" cy="49" r="12" /><circle cx="114" cy="99" r="12" />
                <circle cx="54" cy="183" r="12" /><circle cx="87" cy="219" r="12" /><circle cx="120" cy="255" r="12" />
              </g>
            </g>
          </g>
          <g transform="translate(122 307) rotate(-16 47 47)">
            <g className="dm-sculpture-coin">
              <ellipse cx="51" cy="57" rx="49" ry="43" fill={`url(#${edge})`} />
              <circle cx="47" cy="47" r="47" fill={`url(#${metal})`} /><circle cx="47" cy="47" r="40" className="dm-sculpture-coin-rim" />
              <path d="M47 15L28 47 47 58 66 47ZM28 53L47 79 66 53 47 64Z" fill="var(--bg)" opacity="0.8" />
              <path d="M47 15V58L66 47Z" fill="var(--bg)" opacity="0.22" />
            </g>
          </g>
          <g transform="translate(483 309) rotate(18 32 32)">
            <g className="dm-sculpture-satellite">
              <circle cx="37" cy="39" r="34" fill="#692930" />
              <circle cx="32" cy="32" r="34" fill="#cf5660" />
              <circle cx="32" cy="32" r="26" fill="none" stroke="#ffffff" strokeOpacity=".22" />
              <text x="32" y="39" textAnchor="middle" fill="#fff" fontFamily="var(--font-sans)" fontSize="22" fontWeight="750" fontStyle="italic">OP</text>
            </g>
          </g>
        </g>
      </svg>
      {!still && <span ref={spotlight} className="dm-hero-spotlight" aria-hidden="true" />}
    </>
  )
}
