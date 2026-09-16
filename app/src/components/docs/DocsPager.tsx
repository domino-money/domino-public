import { docNeighbours } from '../../lib/docs/registry'
import { docsHref } from '../explore/routes'
import { IconChevronLeft, IconChevronRight } from '../icons'

/** The pages before and after this one, as two cards at the end of the article. */
export function DocsPager({ slug }: { slug: string }) {
  const { previous, next } = docNeighbours(slug)
  if (!previous && !next) return null
  return (
    <nav aria-label="Previous and next pages" className="dm-docs-pager">
      {previous && (
        <a href={docsHref(previous.slug)} rel="prev" data-dir="previous" className="dm-card dm-docs-pager-link">
          <IconChevronLeft size={16} className="dm-docs-pager-chev" />
          <span className="dm-docs-pager-text">
            <span className="dm-docs-pager-caption">
              Previous<span className="sr-only">: </span>
            </span>
            <span className="dm-docs-pager-title">{previous.title}</span>
          </span>
        </a>
      )}
      {next && (
        <a href={docsHref(next.slug)} rel="next" data-dir="next" className="dm-card dm-docs-pager-link">
          <span className="dm-docs-pager-text">
            <span className="dm-docs-pager-caption">
              Next<span className="sr-only">: </span>
            </span>
            <span className="dm-docs-pager-title">{next.title}</span>
          </span>
          <IconChevronRight size={16} className="dm-docs-pager-chev" />
        </a>
      )}
    </nav>
  )
}
