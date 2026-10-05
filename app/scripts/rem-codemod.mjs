#!/usr/bin/env node
/**
 * Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%; at 80% it looks right): every length the
 * site's stylesheets and Tailwind classes write in px is written in rem instead, 16 design px to the rem, so the root's
 * font-size (styles/tokens.css) scales the whole page at once, as the browser's own zoom would, while the browser keeps
 * measuring in CSS pixels (menus, tooltips and charts placed with getBoundingClientRect stay where they belong).
 *
 *   node scripts/rem-codemod.mjs           rewrites the files under src
 *   node scripts/rem-codemod.mjs --check   rewrites nothing: names the files it would change and exits 1 if there are any
 *   node scripts/rem-codemod.mjs --explain also lists every declaration it leaves in px because it is in SVG units
 *
 * It is idempotent: a second run changes nothing. Run it again after a merge brings new CSS or new classes
 * (tests/rem-codemod.test.mjs fails while anything is left to convert).
 *
 * What it rewrites:
 *   - every CSS file under src (styles/*.css, src/v2in/**.css, ...), except styles/fonts.css (Google's stylesheet as
 *     served, pinned by tests/fonts.test.mjs);
 *   - every Tailwind arbitrary value with px in src/**.{ts,tsx}: a max-w of [520px] becomes one of [32.5rem].
 *
 * What stays px:
 *   - a length of at most 2px (hairline borders, `inset 0 0 0 1px` rings, focus offsets, letter-spacing, the small
 *     nudges): crisp at every scale, as they are at any zoom;
 *   - 999px and 9999px, the pill radii;
 *   - @media preludes: a media query measures the viewport, and rem there means the browser's text size, not the root's;
 *   - comments, strings and url(...);
 *   - @property and @font-face blocks (an @property initial value must not depend on the root);
 *   - the root's own font-size (html, :root): it is the scale itself, and rem there means the browser's text size;
 *   - a length that lives in an SVG drawing's own units: a rule whose subject sits inside an <svg> (its class is used on
 *     an SVG element, or an ancestor in the selector is an <svg>'s class), and the @keyframes such rules animate with.
 *     The drawing's viewBox scales it already; in rem it would shrink twice. Charts draw in design px through their
 *     viewBox too (lib/rootScale.ts), so their axis text keeps its px size. Which classes are SVG classes is read from
 *     the JSX itself (every className on an <svg> and inside one), so a new drawing needs nothing here;
 *   - Tailwind variants with an arbitrary value (min- or max- with [640px], then a colon): those are media queries.
 *
 * (This file and tests/rem-codemod.test.mjs never write a whole Tailwind class, nor the container at-rule's name in one
 * piece: Tailwind scans every file of the app, scripts and tests included, and would build each into the site's
 * stylesheet.)
 *
 * What is converted although it is a query: container query preludes. A container query measures its container in CSS
 * pixels, which the root's scale has already shrunk, and rem in a container query is the root's (unlike in @media):
 * in rem a container switches layout at the same design width as before.
 *
 * Lengths written in script (inline styles, an outer <svg>'s width and height, a chart's geometry) are not this
 * script's: they follow the scale through src/lib/rootScale.ts.
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(APP, 'src')

export const PX_PER_REM = 16
/** At most this many px stays px. */
export const HAIRLINE = 2
/** Pill radii. */
const PILLS = new Set([999, 9999])
/** Files under src that are never rewritten. */
const SKIP = new Set(['styles/fonts.css'])

const rel = (file) => relative(SRC, file).split(sep).join('/')

function filesUnder(dir, test) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, test))
    else if (test(name)) out.push(path)
  }
  return out
}

/** `24` as `1.5rem`; a length that stays px comes back as it was written. */
function length(number) {
  const value = Number(number)
  if (!Number.isFinite(value) || Math.abs(value) <= HAIRLINE || PILLS.has(Math.abs(value))) return `${number}px`
  return `${Number((value / PX_PER_REM).toFixed(6))}rem`
}

/** Every px length in plain value text (no comments, strings or url() inside: callers cut those out). */
const PX = /(?<![\w.#-])(-?(?:\d+\.?\d*|\.\d+))px(?![\w-])/g
const convertPlain = (text, count) =>
  text.replace(PX, (whole, number) => {
    const next = length(number)
    if (next !== whole) count.n++
    return next
  })

/** Converts the px lengths of a value, leaving comments, strings and url(...) exactly as they are. */
export function convertValue(text, count = { n: 0 }) {
  let out = ''
  let plain = ''
  let i = 0
  const flush = () => {
    out += convertPlain(plain, count)
    plain = ''
  }
  while (i < text.length) {
    let stop = -1
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      stop = end < 0 ? text.length : end + 2
    } else if (text[i] === '"' || text[i] === "'") stop = skipString(text, i)
    else if (/^url\(/i.test(text.slice(i, i + 4))) stop = skipUrl(text, i)
    if (stop < 0) {
      plain += text[i]
      i++
      continue
    }
    flush()
    out += text.slice(i, stop)
    i = stop
  }
  flush()
  return out
}

function skipString(text, at) {
  const quote = text[at]
  let i = at + 1
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
  return Math.min(text.length, i + 1)
}

function skipUrl(text, at) {
  let i = at + 4
  while (i < text.length && /\s/.test(text[i])) i++
  if (text[i] === '"' || text[i] === "'") i = skipString(text, i)
  const close = text.indexOf(')', i)
  return close < 0 ? text.length : close + 1
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ')
/** The same text with each comment blanked out, every position kept. */
const blankComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length))

/**
 * The stylesheet as a flat list: each block's prelude (`open`) and each declaration or statement (`decl`), with its
 * position and the preludes of the blocks it sits in.
 */
function structure(css) {
  const items = []
  const stack = []
  let segment = 0
  let parens = 0
  let i = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 2
    } else if (c === '"' || c === "'") {
      i = skipString(css, i)
    } else if (c === '(') {
      parens++
      i++
    } else if (c === ')') {
      parens = Math.max(0, parens - 1)
      i++
    } else if (parens > 0) {
      i++
    } else if (c === '{') {
      const prelude = stripComments(css.slice(segment, i)).trim()
      items.push({ type: 'open', start: segment, end: i, prelude, stack: [...stack] })
      stack.push(prelude)
      segment = ++i
    } else if (c === ';' || c === '}') {
      if (stripComments(css.slice(segment, i)).trim()) items.push({ type: 'decl', start: segment, end: i, stack: [...stack] })
      if (c === '}') stack.pop()
      segment = ++i
    } else {
      i++
    }
  }
  return items
}

/** The comma-separated parts of a selector list or a value, not splitting inside (), [] or strings. */
function splitTop(text, separator) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") i = skipString(text, i) - 1
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && c === separator) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** A complex selector's compounds, split at combinators outside () and []: `.a > .b:is(.c, .d)` is `.a`, `.b:is(.c, .d)`. */
function compounds(selector) {
  const out = []
  let depth = 0
  let current = ''
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (c === '"' || c === "'") {
      const stop = skipString(selector, i)
      current += selector.slice(i, stop)
      i = stop - 1
      continue
    }
    if (c === '(' || c === '[') depth++
    if (c === ')' || c === ']') depth--
    if (depth === 0 && (/\s/.test(c) || c === '>' || c === '+' || c === '~')) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += c
  }
  if (current) out.push(current)
  return out
}

const classesIn = (compound) => [...compound.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1])
/** SVG element type selectors (the outer <svg> itself is a box in the page, so it is not one of them). */
const SVG_ELEMENT = /(^|[\s(,])(g|path|rect|circle|ellipse|line|polyline|polygon|text|tspan|stop|use|linearGradient|radialGradient|clipPath|mask|pattern)(?=$|[.#:[\s),])/
const svgTypeIn = (compound) => SVG_ELEMENT.test(compound.replace(/\[[^\]]*\]/g, ''))

/* ---- What the JSX says is SVG ----------------------------------------------------------------------------------- */

const SVG_TAGS = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'stop', 'linearGradient', 'radialGradient', 'clipPath', 'mask', 'defs', 'use', 'pattern', 'symbol', 'marker', 'image'])

/**
 * Every class name the JSX sources write, by where it lands: on an outer <svg> (`root`), on an element inside one or on
 * an SVG element (`part`), anywhere else (`html`). A template's `dm-vig-${kind}` counts as the prefix `dm-vig-`; a name
 * that only a prefix matches is never one a page box carries by name.
 */
export function svgModel(sources) {
  const { parse } = createRequire(import.meta.url)('@babel/parser')
  const model = { root: new Set(), rootPrefix: new Set(), part: new Set(), partPrefix: new Set(), html: new Set() }
  const record = (kind, tokens) => {
    for (const { name, prefix } of tokens) {
      if (prefix) {
        if (kind === 'root') model.rootPrefix.add(name)
        if (kind === 'part') model.partPrefix.add(name)
      } else model[kind].add(name)
    }
  }
  const tokensOf = (node) => {
    const out = []
    const visit = (value) => {
      if (!value) return
      if (value.type === 'StringLiteral') out.push(...value.value.split(/\s+/).filter(Boolean).map((name) => ({ name })))
      else if (value.type === 'TemplateLiteral') {
        value.quasis.forEach((quasi, index) => {
          const text = quasi.value.cooked ?? quasi.value.raw
          const words = text.split(/\s+/)
          words.forEach((word, at) => {
            if (!word) return
            const first = at === 0 && index > 0 && !/^\s/.test(text)
            const last = at === words.length - 1 && index < value.quasis.length - 1 && !/\s$/.test(text)
            if (first) return // the tail of a name an expression starts
            out.push(last ? { name: word, prefix: true } : { name: word })
          })
        })
        value.expressions.forEach(visit)
      } else if (value.type === 'JSXExpressionContainer') visit(value.expression)
      else if (value.type === 'CallExpression') value.arguments.forEach(visit)
      else if (value.type === 'LogicalExpression' || value.type === 'BinaryExpression') {
        visit(value.left)
        visit(value.right)
      } else if (value.type === 'ConditionalExpression') {
        visit(value.consequent)
        visit(value.alternate)
      } else if (value.type === 'ArrayExpression') value.elements.forEach(visit)
    }
    visit(node)
    return out
  }
  for (const { text } of sources) {
    const ast = parse(text, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
    const walk = (node, inSvg) => {
      if (!node || typeof node.type !== 'string') return
      let inside = inSvg
      if (node.type === 'JSXElement') {
        const name = node.openingElement.name
        const tag = name.type === 'JSXIdentifier' ? name.name : ''
        const attr = node.openingElement.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === 'className')
        const kind = tag === 'svg' && !inSvg ? 'root' : inSvg || SVG_TAGS.has(tag) ? 'part' : 'html'
        if (attr) record(kind, tokensOf(attr.value))
        if (tag === 'svg') inside = true
        if (tag === 'foreignObject') inside = false
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments') continue
        const child = node[key]
        if (Array.isArray(child)) for (const one of child) walk(one, inside)
        else if (child && typeof child === 'object' && typeof child.type === 'string') walk(child, inside)
      }
    }
    walk(ast.program, false)
  }
  const byPrefix = (prefixes, name) => [...prefixes].some((prefix) => name.startsWith(prefix) && name.length > prefix.length)
  model.isRoot = (name) => model.root.has(name) || (!model.html.has(name) && !model.part.has(name) && byPrefix(model.rootPrefix, name))
  model.isPart = (name) => model.part.has(name) || (!model.html.has(name) && !model.root.has(name) && byPrefix(model.partPrefix, name))
  return model
}

/** Whether a complex selector's subject sits inside an SVG drawing. */
function insideSvg(selector, model) {
  const parts = compounds(selector)
  if (parts.length === 0) return false
  const subject = parts[parts.length - 1]
  const ancestors = parts.slice(0, -1)
  const svgAncestor = ancestors.some((part) => /(^|[^\w-])svg(?![\w-])/.test(part) || svgTypeIn(part) || classesIn(part).some((name) => model.isRoot(name) || model.isPart(name)))
  if (svgAncestor) return true
  // `:is(.a, .b)` in the subject counts as the subject's.
  return svgTypeIn(subject) || classesIn(subject).some((name) => model.isPart(name))
}

/* ---- CSS ------------------------------------------------------------------------------------------------------- */

const isAt = (prelude, name) => prelude.toLowerCase().startsWith(name)
/** The container query at-rule, its name in two pieces (see the note at the top). */
const CONTAINER = `@${'container'}`
/** Whether every selector of one of these rule preludes is inside an SVG drawing. */
const allInsideSvg = (selectors, model) => selectors.some((prelude) => splitTop(prelude, ',').every((one) => insideSvg(one, model)))

/**
 * One stylesheet's text with its lengths in rem. `keyframesInSvg` names the @keyframes that animate SVG parts;
 * `report` collects counts and what stayed px because it is in SVG units.
 */
export function convertCss(css, { model, keyframesInSvg = new Set(), report = { converted: 0, kept: [] }, name = '' }) {
  const count = { n: 0 }
  let out = ''
  let at = 0
  for (const item of structure(css)) {
    let next = null
    if (item.type === 'open' && isAt(item.prelude, CONTAINER)) {
      // The query part only: the at-rule, a name maybe, then `(max-width: 419px)`.
      next = convertValue(css.slice(item.start, item.end), count)
    } else if (item.type === 'decl') {
      const text = css.slice(item.start, item.end)
      // The property's colon, never one inside a comment before it.
      const colon = blankComments(text).indexOf(':')
      const head = stripComments(text).trim()
      if (colon < 0 || head.startsWith('@')) continue
      if (item.stack.some((prelude) => isAt(prelude, '@property') || isAt(prelude, '@font-face'))) continue
      const frames = item.stack.find((prelude) => isAt(prelude, '@keyframes'))
      const selectors = item.stack.filter((prelude) => !prelude.startsWith('@') && !frames)
      // The root's own font-size is the scale itself: in rem it would mean the browser's text size, a percentage.
      const property = stripComments(text.slice(0, colon)).trim().toLowerCase()
      if (property === 'font-size' && selectors.some((prelude) => splitTop(prelude, ',').some((one) => /^(html|:root)$/i.test(compounds(one).at(-1) ?? '')))) continue
      if ((frames && keyframesInSvg.has(frames.split(/\s+/)[1])) || allInsideSvg(selectors, model)) {
        if (convertValue(text) !== text) report.kept.push(`${name}: ${(frames ?? selectors[selectors.length - 1]).replace(/\s+/g, ' ')} { ${head} }`)
        continue
      }
      next = text.slice(0, colon + 1) + convertValue(text.slice(colon + 1), count)
    }
    if (next === null) continue
    out += css.slice(at, item.start) + next
    at = item.end
  }
  report.converted += count.n
  return out + css.slice(at)
}

/** The animation shorthand's keywords, none of them a name (the easings written so that no Tailwind class appears). */
const TIMING_WORD = /^(?:none|infinite|linear|ease(?:-in(?:-out)?|-out)?|step-(?:start|end)|forwards|backwards|both|normal|reverse|alternate(?:-reverse)?|running|paused|initial|inherit|unset)$/

/** The @keyframes with at least one length the codemod would otherwise convert. */
function keyframesWithLengths(sheets) {
  const out = new Set()
  for (const { css } of sheets) {
    for (const item of structure(css)) {
      const frames = item.type === 'decl' && item.stack.find((prelude) => isAt(prelude, '@keyframes'))
      const text = css.slice(item.start, item.end)
      if (frames && convertValue(text) !== text) out.add(frames.split(/\s+/)[1])
    }
  }
  return out
}

/** The @keyframes the SVG rules animate with (their px are the drawing's own units too), and a warning for any shared one. */
export function svgKeyframes(sheets, model, warnings = []) {
  const svg = new Set()
  const html = new Set()
  const names = (value) => splitTop(value, ',').map((one) => one.split(/\s+/).find((word) => /^[a-zA-Z_-][\w-]*$/.test(word) && !TIMING_WORD.test(word)) ?? '')
  for (const { css } of sheets) {
    for (const item of structure(css)) {
      if (item.type !== 'decl') continue
      const match = /^(animation|animation-name)\s*:\s*([\s\S]*)$/i.exec(stripComments(css.slice(item.start, item.end)).trim())
      if (!match) continue
      const selectors = item.stack.filter((prelude) => !prelude.startsWith('@'))
      if (selectors.length === 0) continue
      const inSvg = allInsideSvg(selectors, model)
      for (const name of names(match[2])) if (name) (inSvg ? svg : html).add(name)
    }
  }
  // Only a shared @keyframes with a length to convert matters.
  const lengths = keyframesWithLengths(sheets)
  for (const name of svg) if (html.has(name) && lengths.has(name)) warnings.push(`@keyframes ${name} animates an SVG part and a page box: its px stay px`)
  return svg
}

/** Rules that mix SVG and page selectors in one list cannot be classed: named so a person splits them. */
function mixedRules(sheets, model, warnings) {
  for (const { name, css } of sheets) {
    const items = structure(css)
    items.forEach((item, index) => {
      if (item.type !== 'open' || item.prelude.startsWith('@') || item.stack.some((prelude) => isAt(prelude, '@keyframes'))) return
      const parts = splitTop(item.prelude, ',')
      const inside = parts.filter((one) => insideSvg(one, model))
      if (inside.length === 0 || inside.length === parts.length) return
      // The rule's own declarations, not those of blocks nested in it.
      const depth = item.stack.length + 1
      const body = []
      for (const next of items.slice(index + 1)) {
        if (next.stack.length < depth) break
        if (next.type === 'decl' && next.stack.length === depth) body.push(css.slice(next.start, next.end))
      }
      const text = body.join(';')
      if (convertValue(text) !== text) warnings.push(`${name}: "${item.prelude.replace(/\s+/g, ' ')}" mixes SVG parts and page boxes: its px are converted`)
    })
  }
}

/* ---- Tailwind classes ------------------------------------------------------------------------------------------ */

/**
 * A utility with an arbitrary value: a name and a dash (with any variants before it: md:, hover:, a leading minus or
 * bang), then a bracketed value with px in it, a calc() or a shadow's underscores included. A variant with an
 * arbitrary value (a min- or max- breakpoint) is followed by a colon and left alone.
 */
const ARBITRARY = /(?<![\w-])((?:[\w-]+:)*!?-?[a-z][a-z0-9-]*-)\[([^\]\s"'`]*\dpx[^\]\s"'`]*)\](?![\w:[-])/g
const PX_IN_CLASS = /(?<![A-Za-z0-9.])(-?(?:\d+\.?\d*|\.\d+))px(?![\w-])/g

/** A script's text with the px lengths of its Tailwind arbitrary values in rem. */
export function convertClasses(text, report = { classes: 0 }) {
  return text.replace(ARBITRARY, (whole, utility, value) => {
    if (/url\(/i.test(value)) return whole
    const next = value.replace(PX_IN_CLASS, (match, number) => {
      const converted = length(number)
      if (converted !== match) report.classes++
      return converted
    })
    return `${utility}[${next}]`
  })
}

/* ---- Run -------------------------------------------------------------------------------------------------------- */

/** Rewrites (or with `check`, only measures) every file under src. Returns what changed, the warnings and the report. */
export function run({ check = false } = {}) {
  const read = (file) => ({ file, name: rel(file), text: readFileSync(file, 'utf8') })
  const scripts = filesUnder(SRC, (name) => /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')).map(read)
  const sheets = filesUnder(SRC, (name) => name.endsWith('.css'))
    .map(read)
    .filter(({ name }) => !SKIP.has(name))
    .map((sheet) => ({ ...sheet, css: sheet.text }))
  const model = svgModel(scripts.filter(({ name }) => name.endsWith('.tsx')))
  const warnings = []
  const keyframesInSvg = svgKeyframes(sheets, model, warnings)
  mixedRules(sheets, model, warnings)
  const report = { converted: 0, classes: 0, kept: [] }
  const changed = []
  for (const sheet of sheets) {
    const after = convertCss(sheet.css, { model, keyframesInSvg, report, name: sheet.name })
    if (after === sheet.css) continue
    changed.push(sheet.name)
    if (!check) writeFileSync(sheet.file, after)
  }
  for (const script of scripts) {
    const after = convertClasses(script.text, report)
    if (after === script.text) continue
    changed.push(script.name)
    if (!check) writeFileSync(script.file, after)
  }
  const kept = keyframesWithLengths(sheets)
  return { changed, warnings, report, keyframes: [...keyframesInSvg].filter((name) => kept.has(name)).sort() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check')
  const { changed, warnings, report, keyframes } = run({ check })
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  if (check) {
    if (changed.length > 0) {
      console.error(`rem-codemod: ${changed.length} file(s) still write px lengths that should be rem:\n  ${changed.join('\n  ')}`)
      process.exit(1)
    }
    console.log('rem-codemod: nothing to change')
  } else {
    console.log(`rem-codemod: ${report.converted} CSS lengths and ${report.classes} class lengths in rem, ${changed.length} file(s) rewritten`)
    console.log(`  @keyframes left in SVG units: ${keyframes.join(', ') || 'none'}`)
    if (process.argv.includes('--explain')) for (const kept of report.kept) console.log(`  kept in SVG units: ${kept}`)
    for (const file of changed) console.log(`  ${file}`)
  }
}
