import { Fragment, type CSSProperties } from 'react'
import { shotSrc } from '../../lib/docs/blocks'
import { docGroupOf, tocOf } from '../../lib/docs/registry'
import { SHOTS, type Shot } from '../../lib/docs/shots'
import type { Block, DocPage, DocSection, Inline } from '../../lib/docs/types'
import { RoadmapPill } from '../../screens/Automate'
import { docsHref } from '../explore/routes'
import { IconInfo } from '../icons'
import { CopyButton } from '../read/screens/CopyButton'
import { Display, KeyValue, KeyValueList } from '../ui'
import { DocsDiagram } from './DocsDiagram'
import { DocsPager } from './DocsPager'
import { DocsToc } from './DocsToc'

/** The docs' phone width, where a picture's phone shot is served (docs.css draws the page for a phone below 640 px). */
const PHONE_MEDIA = '(max-width: 639px)'

/** Inline text: words, bold words, code-like words and links inside this app. */
function Text({ parts }: { parts: readonly Inline[] }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === 'string' ? (
          <Fragment key={index}>{part}</Fragment>
        ) : 'b' in part ? (
          <strong key={index}>{part.b}</strong>
        ) : 'mono' in part ? (
          <code key={index} className="dm-docs-mono">
            {part.mono}
          </code>
        ) : (
          <a key={index} href={part.to} className="dm-docs-link">
            {part.text}
          </a>
        ),
      )}
    </>
  )
}

function Bullets({ items }: { items: readonly (readonly Inline[])[] }) {
  return (
    <ul className="dm-docs-list">
      {items.map((item, index) => (
        <li key={index}>
          <Text parts={item} />
        </li>
      ))}
    </ul>
  )
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'p':
      return (
        <p className="dm-docs-p">
          <Text parts={block.text} />
        </p>
      )
    case 'list':
      return <Bullets items={block.items} />
    case 'steps':
      return (
        <ol className="dm-card dm-docs-steps">
          {block.items.map((step, index) => (
            <li key={step.title} className="dm-docs-step">
              <span aria-hidden="true" className="dm-docs-step-n tnum">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0">
                <p className="dm-docs-step-title">{step.title}</p>
                <p className="dm-docs-step-body">
                  <Text parts={step.body} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      )
    case 'note':
      return (
        <div className="dm-inset dm-docs-note">
          <IconInfo className="dm-docs-note-icon" />
          <p>
            {block.title && <strong className="dm-docs-note-title">{block.title}</strong>}
            <Text parts={block.text} />
          </p>
        </div>
      )
    case 'facts':
      return (
        <dl className="dm-card dm-docs-facts">
          {block.rows.map((row) => (
            <div key={row.label} className="dm-docs-fact">
              <dt>{row.label}</dt>
              <dd>
                <span className="dm-docs-fact-value">{row.value}</span>
                {row.note && <span className="dm-docs-fact-note">{row.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )
    case 'addresses':
      return (
        <div className="dm-card dm-docs-addresses">
          <KeyValueList>
            {block.rows.map((row) => (
              <KeyValue
                key={row.address}
                label={
                  <>
                    <span className="dm-docs-addr-name">{row.label}</span>
                    <span className="dm-docs-addr-role">{row.role}</span>
                  </>
                }
                mono
                action={<CopyButton value={row.address} label={`Copy the ${row.label} address`} />}
              >
                <span translate="no">{row.address}</span>
              </KeyValue>
            ))}
          </KeyValueList>
        </div>
      )
    case 'split':
      return (
        <div className="dm-docs-split">
          {block.columns.map((column) => (
            <div key={column.title} className="dm-inset dm-docs-split-col">
              <p className="dm-docs-split-title">{column.title}</p>
              <Bullets items={column.items} />
            </div>
          ))}
        </div>
      )
    case 'shot': {
      // Sized by its own pixels, so the page keeps its place while the picture loads; lazy, so a page loads only what is read.
      // Under 640 px the phone picture, shot in a phone's window, so its words keep their size (2026-09-27, review of 260a76a).
      const { width, height, phone, alt }: Shot = SHOTS[block.shot]
      // Drawn at twice its size for sharp text, so never wider than half its pixels: a narrow card stays card-sized.
      const widths = { '--dm-shot-w': `${width / 2}px`, '--dm-shot-phone-w': `${(phone ?? { width }).width / 2}px` } as CSSProperties
      return (
        <figure className="dm-docs-figure" data-docs-shot={block.shot}>
          <div className="dm-docs-shot" style={widths}>
            <picture>
              {phone && <source media={PHONE_MEDIA} srcSet={shotSrc(block.shot, true)} width={phone.width} height={phone.height} />}
              <img src={shotSrc(block.shot)} width={width} height={height} alt={alt} loading="lazy" decoding="async" />
            </picture>
          </div>
          <figcaption>
            <span>{block.caption}</span>
            <span className="dm-docs-figure-tag">Made-up figures</span>
          </figcaption>
        </figure>
      )
    }
    case 'diagram':
      return (
        <figure className="dm-docs-figure" data-docs-diagram={block.name}>
          <div className="dm-docs-diagram">
            <DocsDiagram name={block.name} alt={block.alt} />
          </div>
          <figcaption>
            <span>{block.caption}</span>
          </figcaption>
        </figure>
      )
    case 'terms':
      return (
        <dl className="dm-docs-terms">
          {block.items.map((item) => (
            <div key={item.id} id={item.id} className="dm-docs-term">
              <dt>{item.term}</dt>
              <dd>
                <Text parts={item.text} />
              </dd>
            </div>
          ))}
        </dl>
      )
  }
}

function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  )
}

function SectionView({ section }: { section: DocSection }) {
  return (
    <section id={section.id} className="dm-docs-section">
      <h2 className="dm-docs-h2">{section.title}</h2>
      <Blocks blocks={section.blocks} />
      {section.subsections?.map((sub) => (
        <section key={sub.id} id={sub.id} className="dm-docs-sub">
          <h3 className="dm-docs-h3">{sub.title}</h3>
          <Blocks blocks={sub.blocks} />
        </section>
      ))}
    </section>
  )
}

/**
 * One docs page: where it sits, its title and its opening line, "On this
 * page" as a disclosure when the rail is not beside it, the sections, then
 * the pages before and after it. `crumbs` is off where the docs menu above
 * already names the group.
 */
export function DocsArticle({ page, tocInline, crumbs }: { page: DocPage; tocInline: boolean; crumbs: boolean }) {
  const group = docGroupOf(page.slug)
  const entries = tocOf(page)
  return (
    <article className="dm-docs-article" data-docs-page={page.slug}>
      {crumbs && group && (
        <nav aria-label="Breadcrumb" className="dm-docs-crumbs">
          <ol>
            <li>
              <a href={docsHref()}>Docs</a>
            </li>
            <li>{group.title}</li>
          </ol>
        </nav>
      )}
      <div className="dm-docs-head animate-rise">
        <div className="dm-docs-title">
          <Display as="h1" className="dm-display-title">
            {page.title}
          </Display>
          {page.status && <RoadmapPill name={page.status} />}
        </div>
        <p className="dm-docs-lead">{page.lead ?? page.summary}</p>
      </div>
      {tocInline && entries.length > 0 && (
        <details className="dm-details dm-docs-toc-menu">
          <summary>On this page</summary>
          <DocsToc slug={page.slug} entries={entries} />
        </details>
      )}
      <div className="dm-docs-prose animate-fade">
        {page.sections.map((section) => (
          <SectionView key={section.id} section={section} />
        ))}
      </div>
      <DocsPager slug={page.slug} />
    </article>
  )
}
