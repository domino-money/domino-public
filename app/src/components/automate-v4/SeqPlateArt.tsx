/*
 * The plates of Set up automation's empty states (V4, the owner's approved site/sequence.html .es-plate and
 * states/Sequence.html .es-sm): "Connect your wallet" draws an outlined tile above a wallet, which slips in when the
 * button or the plate is pointed at; "No positions available" draws an outlined tile and a dotted arc, which swings.
 * Passed as EmptyState's icon; decoration only (EmptyState hides its art from assistive technology).
 */

export function ConnectArt() {
  return (
    <svg className="dm-seq-plate-art" data-art="connect" width="132" height="104" viewBox="0 0 132 104" fill="none" aria-hidden="true" focusable="false">
      <g className="es-tile">
        <rect x="52.6" y="6.6" width="22.8" height="40.8" rx="5.2" fill="rgb(255 157 98 / .07)" stroke="rgb(255 157 98 / .6)" strokeWidth="1.2" />
        <path d="M56.5 27h15" stroke="rgb(255 157 98 / .5)" strokeWidth="1.1" strokeLinecap="round" />
        <circle cx="58.8" cy="14.2" r="1.8" fill="rgb(255 157 98 / .6)" /><circle cx="69.2" cy="20" r="1.8" fill="rgb(255 157 98 / .6)" />
        <circle cx="58.4" cy="33.6" r="1.8" fill="rgb(255 157 98 / .6)" /><circle cx="64" cy="37.8" r="1.8" fill="rgb(255 157 98 / .6)" /><circle cx="69.6" cy="42" r="1.8" fill="rgb(255 157 98 / .6)" />
      </g>
      <rect x="18.75" y="36.75" width="94.5" height="58.5" rx="13" fill="#161411" stroke="rgb(255 236 220 / .24)" strokeWidth="1.5" />
      <path d="M88 55.5h25.25v22.5H88a11.25 11.25 0 0 1 0-22.5Z" fill="#1d1a16" stroke="rgb(255 236 220 / .24)" strokeWidth="1.5" />
      <circle cx="89.5" cy="66.75" r="2.6" fill="#c3bcb2" />
    </svg>
  )
}

export function NoPositionsArt() {
  return (
    <svg className="dm-seq-plate-art" data-art="empty" width="96" height="80" viewBox="0 0 96 80" fill="none" aria-hidden="true" focusable="false">
      <g className="es-arc">
        <path d="M22 52a28 28 0 0 1 38-36" stroke="rgb(255 236 220 / .3)" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="0 5" />
        <path d="M55 11.5 61 16l-5.5 4.6" stroke="rgb(255 236 220 / .4)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g>
        <rect x="38.6" y="22.6" width="18.8" height="34.8" rx="4.4" fill="rgb(255 157 98 / .07)" stroke="rgb(255 157 98 / .6)" strokeWidth="1.2" />
        <path d="M42 40h12" stroke="rgb(255 157 98 / .5)" strokeWidth="1.1" strokeLinecap="round" />
        <circle cx="44.2" cy="29" r="1.5" fill="rgb(255 157 98 / .6)" /><circle cx="51.8" cy="34" r="1.5" fill="rgb(255 157 98 / .6)" />
        <circle cx="43.8" cy="45.4" r="1.5" fill="rgb(255 157 98 / .6)" /><circle cx="48" cy="49" r="1.5" fill="rgb(255 157 98 / .6)" /><circle cx="52.2" cy="52.6" r="1.5" fill="rgb(255 157 98 / .6)" />
      </g>
    </svg>
  )
}
