import type { ReactNode } from 'react'
import { Display } from '../ui'

/** The Tangerine full stop of a serif title: the same "." (or "?") in the text, only coloured (V4 §2.3). */
export function Stop({ children = '.', className }: { children?: string; className?: string }) {
  return <span className={className ? `dm-stop ${className}` : 'dm-stop'}>{children}</span>
}

/**
 * A Home chapter's two-line serif title (V4 "sx-t"): the second line indented like "Keep control.". The warm copy the
 * light reveals is a sibling laid over it, never inside the heading, so the heading's text and name stay its own. The
 * space between the two lines is a real one (a block line drops it on screen), so the heading's name reads as words.
 */
export function ChapterTitle({ id, first, second }: { id: string; first: ReactNode; second: ReactNode }) {
  const lines = (
    <>
      <span className="dm-sx-l">{first}</span>{' '}<span className="dm-sx-l dm-sx-l2">{second}</span>
    </>
  )
  return (
    <div className="dm-sx-head">
      <Display as="h2" id={id} className="dm-home-chapter-title dm-sx-t">
        {lines}
      </Display>
      <span className="dm-sx-t dm-sx-sh" aria-hidden="true" data-home-sheen="">
        {lines}
      </span>
    </div>
  )
}
