import { Fragment } from 'react'

/**
 * A figure written for a narrow column that never breaks inside a number:
 * not inside a digit group and not after the decimal point. Six significant
 * digits keep an amount on one line; only a whole part wider than its column
 * may wrap, and then only between its digit groups. Tabular digits.
 */
export function Figure({ text }: { text: string }) {
  const [whole, fraction] = text.split('.')
  const groups = whole.split(',')
  return (
    <span className="tnum wrap-normal">
      {groups.map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {i < groups.length - 1 ? `${group},` : fraction === undefined ? group : `${group}.${fraction}`}
        </Fragment>
      ))}
    </span>
  )
}
