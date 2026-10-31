import { Fragment, type CSSProperties } from 'react'
import { shotSrc } from '../../lib/docs/blocks'
import { docGroupOf, tocOf } from '../../lib/docs/registry'
import { SHOTS, type Shot } from '../../lib/docs/shots'
import type { Block, DocChain, DocPage, DocSection, Inline } from '../../lib/docs/types'
import { ROBINHOOD_EXPLORER } from '../../config/chainIdentity'
import { RoadmapPill } from '../automate/RoadmapPill'
import { docsHref } from '../explore/routes'
import { IconInfo } from '../icons'
import { CopyButton } from '../read/screens/CopyButton'
import { Display, KeyValue, KeyValueList } from '../ui'
import { DocsDiagram } from './DocsDiagram'
import { DocsPager } from './DocsPager'
import { DocsToc } from './DocsToc'
import { rem } from '../../lib/rootScale'

/** The docs' phone width, where a picture's phone shot is served (docs.css draws the page for a phone below 640 px). */
const PHONE_MEDIA = '(max-width: 639px)'

/**
 * Where an address row opens (2026-10-30, QA round 2, the owner's decision on N24: a small explorer link beside each
 * address on Contracts). Links only, a person's own click, never a read: the hosts are v2/explorers.ts's, kept here so the
 * docs chunk does not carry V2's chain profiles. Domino's own contracts open Robin Etherscan on Robinhood Chain, whose
 * Blockscout shows them as bytecode; every other address opens Blockscout there.
 */
const EXPLORERS: Readonly<Record<DocChain, { name: string; host: string }>> = {
  4663: { name: 'Robinhood explorer', host: ROBINHOOD_EXPLORER },
  8453: { name: 'Basescan', host: 'https://basescan.org' },
  42161: { name: 'Arbiscan', host: 'https://arbiscan.io' },
}
const ROBIN_ETHERSCAN = 'https://robin.etherscan.io'

/** `name`: the row's contract name, with its role where two rows of the block share a name (two DominoV2VaultFactory rows open different addresses). */
function ExplorerLinks({ name, address, chains, domino }: { name: string; address: string; chains: readonly DocChain[]; domino: boolean }) {
  return (
    <span className="dm-docs-addr-links">
      {chains.map((chain) => (
        <a
          key={chain}
          href={`${domino && chain === 4663 ? ROBIN_ETHERSCAN : EXPLORERS[chain].host}/address/${address}`}
          target="_blank"
          rel="noreferrer noopener"
          className="dm-docs-link"
          aria-label={`${name} on ${EXPLORERS[chain].name} (opens in a new tab)`}
          data-docs-explorer={chain}
        >
          {EXPLORERS[chain].name}
        </a>
      ))}
    </span>
  )
}

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
        <ol className="dm-card dm-docs-steps dm-lit">
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
    case 'addresses': {
      const shared = new Set(block.rows.map((row) => row.label).filter((label, index, labels) => labels.indexOf(label) !== index))
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
                    {row.chains && row.chains.length > 0 && <ExplorerLinks name={shared.has(row.label) ? `${row.label}, ${row.role},` : row.label} address={row.address} chains={row.chains} domino={row.domino === true} />}
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
    }
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
      // Drawn at twice its size for sharp text, so never wider than half its pixels: a narrow card stays card-sized. Half
      // its pixels in design px, written in rem so it scales with the page (changed on purpose 2026-10-03, lib/rootScale.ts).
      const widths = { '--dm-shot-w': rem(width / 2), '--dm-shot-phone-w': rem((phone ?? { width }).width / 2) } as CSSProperties
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
          <div className="dm-docs-diagram dm-lit">
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
      <div className="dm-docs-head">
        <div className="dm-docs-title">
          <Display as="h1" className="dm-display-title">
            {page.title}
          </Display>
          {page.status && <RoadmapPill name={page.status} />}
        </div>
        <p className="dm-docs-lead dm-k-up1">{page.lead ?? page.summary}</p>
      </div>
      {tocInline && entries.length > 0 && (
        <details className="dm-details dm-docs-toc-menu dm-k-up1">
          <summary>On this page</summary>
          <DocsToc slug={page.slug} entries={entries} />
        </details>
      )}
      <div className="dm-docs-prose dm-k-card">
        {page.sections.map((section) => (
          <SectionView key={section.id} section={section} />
        ))}
      </div>
      <DocsPager slug={page.slug} />
    </article>
  )
}
