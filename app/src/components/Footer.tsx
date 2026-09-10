const COLUMNS = [
  { heading: 'Learn', links: ['How a position works', 'Ranges explained', 'Fees and profit'] },
  { heading: 'Product', links: ['Positions', 'Activity', 'Practice workspace'] },
  { heading: 'Resources', links: ['Documentation', 'Security', 'Status'] },
]

/* Inline marks so nothing is fetched from a third-party host. */
const SOCIALS = [
  {
    name: 'X',
    href: '#/',
    path: 'M17.53 3h3.07l-6.7 7.66L21.75 21h-5.99l-4.7-6.14L5.7 21H2.63l7.17-8.19L2.25 3h6.14l4.25 5.62L17.53 3Zm-1.08 16.14h1.7L7.63 4.77H5.8l10.65 14.37Z',
  },
  {
    name: 'Discord',
    href: '#/',
    path: 'M19.3 5.34A16.7 16.7 0 0 0 15.15 4c-.2.36-.42.84-.58 1.22a15.6 15.6 0 0 0-4.66 0A11.4 11.4 0 0 0 9.32 4a16.6 16.6 0 0 0-4.15 1.34C2.55 9.25 1.84 13.06 2.2 16.8a16.8 16.8 0 0 0 5.1 2.6c.41-.57.78-1.17 1.09-1.8a10.9 10.9 0 0 1-1.72-.83c.15-.1.29-.22.42-.33a12 12 0 0 0 10.3 0c.14.11.28.22.43.33-.55.33-1.13.6-1.73.83.32.63.68 1.23 1.09 1.8a16.7 16.7 0 0 0 5.1-2.6c.43-4.33-.7-8.11-2.98-11.46ZM8.68 14.5c-1 0-1.81-.92-1.81-2.04 0-1.13.79-2.05 1.81-2.05 1.03 0 1.84.93 1.82 2.05 0 1.12-.8 2.04-1.82 2.04Zm6.64 0c-1 0-1.81-.92-1.81-2.04 0-1.13.79-2.05 1.81-2.05 1.03 0 1.83.93 1.82 2.05 0 1.12-.79 2.04-1.82 2.04Z',
  },
  {
    name: 'Telegram',
    href: '#/',
    path: 'M21.94 4.6 18.9 19.2c-.23 1.02-.84 1.27-1.7.79l-4.7-3.47-2.27 2.19c-.25.25-.46.46-.95.46l.34-4.8 8.73-7.9c.38-.33-.08-.52-.59-.19L6.98 13.07l-4.65-1.45c-1.01-.32-1.03-1.01.21-1.5l18.17-7c.84-.31 1.58.2 1.23 1.48Z',
  },
  {
    name: 'GitHub',
    href: '#/',
    path: 'M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49l-.01-1.9c-2.78.62-3.37-1.23-3.37-1.23-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.85.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.03 10.03 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z',
  },
]

export function Footer() {
  return (
    <footer className="mt-24 border-t">
      <div className="mx-auto max-w-[1220px] px-5 py-14">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))]">
          <div>
            <span className="font-display text-[22px]">
              domino<span style={{ color: 'var(--primary)' }}>.</span>
            </span>
            <p className="mt-3 max-w-[38ch] text-[13px] leading-relaxed text-fg-muted">
              Guided liquidity positions on Uniswap v4, built for Robinhood Chain. Your wallet stays
              the owner of everything it creates.
            </p>

            <div className="mt-5 flex gap-2">
              {SOCIALS.map((s) => (
                <a
                  key={s.name}
                  href={s.href}
                  aria-label={s.name}
                  title={s.name}
                  className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] border text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d={s.path} />
                  </svg>
                </a>
              ))}
            </div>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h4 className="text-[13px] font-medium">{col.heading}</h4>
              <ul className="mt-3 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link}>
                    <a href="#/" className="text-[13px] text-fg-muted transition hover:text-fg">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-fg-subtle">
            Private alpha. Figures shown are simulated and carry no financial authorisation.
          </p>
          <div className="flex gap-5">
            <a href="#/" className="text-[12px] text-fg-muted transition hover:text-fg">
              Terms of Service
            </a>
            <a href="#/" className="text-[12px] text-fg-muted transition hover:text-fg">
              Privacy Policy
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}
