'use client';
import { useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Pause,
  Play,
  Plus,
  Layers3,
  Check,
  Clock3,
  ArrowUpRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from '@/components/ui/empty';
import { Switch } from '@/components/ui/switch';
import {
  previewCompound,
  moneyString,
  moneyUnits,
  type CompoundDecision,
} from '@/lib/compound';
import { runPracticeCompound, type PracticeBook } from '@/lib/practice';
import { usd } from '@/lib/position';
import type { BookUpdate } from '@/lib/local-workspace';

type Props = {
  book: PracticeBook;
  setBook: (book: BookUpdate) => void;
  onCreate: () => void;
  onActivity: () => void;
};
export function PositionsPanel({ book, setBook, onCreate, onActivity }: Props) {
  const [selected, setSelected] = useState(''),
    [stage, setStage] = useState<'overview' | 'inputs' | 'review'>('overview');
  const [fees, setFees] = useState('0'),
    [gas, setGas] = useState('0.25');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  const position = book.positions.find((p) => p.id === selected);
  let estimate: CompoundDecision | null = null;
  try {
    if (position)
      estimate = previewCompound({
        availableFeesUsd: moneyString(
          moneyUnits(position.reservesUsd) + moneyUnits(fees),
        ),
        positionValueUsd: (
          position.amount + Number(position.netAddedUsd)
        ).toFixed(6),
        gasUsd: gas,
      });
  } catch {}
  function go(next: typeof stage) {
    setStage(next);
    setError('');
    requestAnimationFrame(() => heading.current?.focus());
  }
  function toggle() {
    if (!position || pending.current) return;
    try {
      const id = crypto.randomUUID(),
        at = new Date().toISOString();
      setBook((previous) => {
        const current = previous.positions.find((p) => p.id === position.id);
        if (current !== position)
          throw Error('This position changed. Review it again.');
        return {
          ...previous,
          positions: previous.positions.map((p) =>
            p.id === current.id ? { ...p, enabled: !p.enabled } : p,
          ),
          events: [
            {
              id,
              positionId: current.id,
              at,
              kind: current.enabled
                ? ('paused' as const)
                : ('resumed' as const),
            },
            ...previous.events,
          ].slice(0, 300),
        };
      });
      setError('');
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not update this practice position.',
      );
    }
  }
  async function simulate() {
    if (!position || !estimate || !position.enabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/compound-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          availableFeesUsd: estimate.availableFeesUsd,
          positionValueUsd: (
            position.amount + Number(position.netAddedUsd)
          ).toFixed(6),
          gasUsd: gas,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw Error('The scenario service could not validate these inputs.');
      const checked = await response.json();
      if (
        !checked ||
        typeof checked !== 'object' ||
        Array.isArray(checked) ||
        Object.keys(estimate).some(
          (key) =>
            (checked as Record<string, unknown>)[key] !==
            estimate[key as keyof CompoundDecision],
        )
      )
        throw Error('The scenario changed. Review it and try again.');
      const eventId = crypto.randomUUID(),
        at = new Date().toISOString();
      setBook((previous) => {
        if (previous.positions.find((p) => p.id === position.id) !== position)
          throw Error('This position changed. Review the scenario again.');
        return runPracticeCompound(
          previous,
          position.id,
          fees,
          gas,
          eventId,
          at,
        );
      });
      setSelected('');
      onActivity();
    } catch (e) {
      setError(
        e instanceof Error && e.name === 'TimeoutError'
          ? 'The check took too long. Nothing was recorded. Try again.'
          : e instanceof Error
            ? e.message
            : 'Could not record the practice scenario.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="dm-page-title">
        <div>
          <p className="dm-eyebrow">YOUR LP COLLECTION</p>
          <h1>Small steps. More possibilities.</h1>
          <p className="dm-muted">
            Your tokens, in a new kind of card. Explore liquidity at your own
            pace.
          </p>
        </div>
        <Button onClick={onCreate} className="dm-new-button">
          <Plus /> New position
        </Button>
      </div>
      {!book.positions.length ? (
        <Empty className="dm-panel dm-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Layers3 />
            </EmptyMedia>
            <EmptyTitle>Meet your first liquidity card.</EmptyTitle>
            <EmptyDescription>
              Pick a starting value, explore a range, and see how trading fees
              could be reinvested. Start with a practice position.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={onCreate}>
            Let&apos;s try it <ArrowRight />
          </Button>
          <p className="dm-small">About a minute. No funds needed.</p>
        </Empty>
      ) : (
        <Dialog
          open={!!position}
          onOpenChange={(open) => {
            if (!open && !pending.current) setSelected('');
          }}
        >
          <div className="dm-position-grid">
            {book.positions.map((p, i) => (
              <article className="dm-position-card" key={p.id}>
                <div className="dm-card-top">
                  <span className="dm-card-number">
                    CARD / {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="dm-status">
                    {p.enabled ? <Check size={13} /> : <Pause size={13} />}
                    {p.enabled ? 'Practice on' : 'Paused'}
                  </span>
                </div>
                <div className="dm-pair">
                  <div className="dm-avatars" aria-hidden="true">
                    <span>M</span>
                    <span>$</span>
                  </div>
                  <div>
                    <h2>MEME / USDG</h2>
                    <p className="dm-small">Robinhood Chain · example pair</p>
                  </div>
                </div>
                <div className="dm-card-value">
                  <span>Value at starting price</span>
                  <strong>{usd(p.amount + Number(p.netAddedUsd))}</strong>
                </div>
                <div className="dm-card-range">
                  <div className="dm-range-track" aria-hidden="true">
                    <span
                      style={{
                        left: `${((1 - p.lower) / (p.upper - p.lower)) * 100}%`,
                      }}
                    />
                  </div>
                  <div>
                    <span>{usd(p.lower)}</span>
                    <span>Start $1.00</span>
                    <span>{usd(p.upper)}</span>
                  </div>
                </div>
                <dl className="dm-card-stats">
                  <div>
                    <dt>Reinvested so far</dt>
                    <dd>{usd(Number(p.netAddedUsd))}</dd>
                  </div>
                  <div>
                    <dt>Fees waiting</dt>
                    <dd>{usd(Number(p.reservesUsd))}</dd>
                  </div>
                </dl>
                <div className="dm-card-footer">
                  <span>Simulation only</span>
                  <DialogTrigger
                    render={
                      <Button
                        variant="outline"
                        aria-label={`Open practice card ${i + 1}`}
                        onClick={() => {
                          setSelected(p.id);
                          setStage('overview');
                          setFees('0');
                          setError('');
                        }}
                      >
                        Open card <ArrowUpRight />
                      </Button>
                    }
                  />
                </div>
              </article>
            ))}
            <button className="dm-add-card" onClick={onCreate}>
              <Plus size={30} />
              <strong>Room for one more.</strong>
              <span>Try another range or starting value.</span>
            </button>
          </div>
          <DialogContent className="dm-flow" showCloseButton={!busy}>
            <header className="dm-flow-header">
              <p className="dm-eyebrow">
                PRACTICE CARD{' '}
                {book.positions.findIndex((p) => p.id === selected) + 1} · MEME
                / USDG
              </p>
              <DialogTitle
                ref={heading}
                tabIndex={-1}
                className="dm-flow-title"
              >
                {stage === 'overview'
                  ? 'A closer look at your card.'
                  : stage === 'inputs'
                    ? 'Let your fees go further.'
                    : 'Here’s what would happen.'}
              </DialogTitle>
              <DialogDescription>
                {stage === 'overview'
                  ? 'Your local practice position, all in one place.'
                  : stage === 'inputs'
                    ? 'Try reinvesting fees at a hypothetical network cost.'
                    : 'Review the amounts before saving this simulation.'}
              </DialogDescription>
            </header>
            <div className="dm-flow-body" aria-busy={busy}>
              {position && stage === 'overview' && (
                <>
                  <div className="dm-card-value">
                    <span>Value at starting price</span>
                    <strong>
                      {usd(position.amount + Number(position.netAddedUsd))}
                    </strong>
                  </div>
                  <dl className="dm-receipt">
                    <div>
                      <dt>Price range</dt>
                      <dd>
                        {usd(position.lower)} – {usd(position.upper)}
                      </dd>
                    </div>
                    <div>
                      <dt>Hypothetical fees added</dt>
                      <dd>{usd(Number(position.feesAddedUsd))}</dd>
                    </div>
                    <div>
                      <dt>Reinvested so far</dt>
                      <dd>{usd(Number(position.netAddedUsd))}</dd>
                    </div>
                    <div>
                      <dt>Fees waiting</dt>
                      <dd>{usd(Number(position.reservesUsd))}</dd>
                    </div>
                    <div>
                      <dt>Service fees simulated</dt>
                      <dd>{usd(Number(position.servicePaidUsd))}</dd>
                    </div>
                  </dl>
                  <div className="dm-pause-control">
                    <div>
                      <strong>
                        {position.enabled
                          ? 'Practice is on'
                          : 'Practice is paused'}
                      </strong>
                      <p className="dm-small">
                        Scenarios run only when you record them.
                      </p>
                    </div>
                    <Button variant="outline" onClick={toggle}>
                      {position.enabled ? <Pause /> : <Play />}
                      {position.enabled ? 'Pause' : 'Resume'}
                    </Button>
                  </div>
                  <p className="dm-small">
                    Pausing reinvestment does not remove liquidity or token
                    exposure in a live position.
                  </p>
                </>
              )}
              {position && stage === 'inputs' && (
                <>
                  <div className="dm-callout">
                    <strong>
                      {usd(Number(position.reservesUsd))} already waiting
                    </strong>
                    <p>
                      Included automatically. Leave new fees at $0 to recheck
                      this balance.
                    </p>
                  </div>
                  <div className="dm-lab-fields">
                    <div>
                      <Label htmlFor="fees">New hypothetical fees ($)</Label>
                      <Input
                        id="fees"
                        value={fees}
                        onChange={(e) => setFees(e.target.value)}
                        inputMode="decimal"
                        aria-describedby="fees-hint"
                      />
                    </div>
                    <div>
                      <Label htmlFor="gas">Network cost ($)</Label>
                      <Input
                        id="gas"
                        value={gas}
                        onChange={(e) => setGas(e.target.value)}
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                  <p id="fees-hint" className="dm-small">
                    New fees are added to the waiting balance. This is not a
                    reinvestment limit.
                  </p>
                  {!estimate && (
                    <p className="dm-error" role="alert">
                      Enter valid non-negative decimal amounts, with at most six
                      decimal places.
                    </p>
                  )}
                  <p className="dm-small">
                    This check assumes balanced assets and a constant price.
                    Live quotes, swaps and automatic execution are not available
                    in practice.
                  </p>
                </>
              )}
              {position && stage === 'review' && estimate && (
                <>
                  <div className="dm-decision-title">
                    <span className="dm-status">
                      {estimate.decision === 'eligible' ? (
                        <Check size={14} />
                      ) : (
                        <Clock3 size={14} />
                      )}
                      {estimate.decision === 'eligible'
                        ? 'Cost check passed'
                        : 'Wait for more fees'}
                    </span>
                    <p>
                      {estimate.decision === 'eligible'
                        ? 'All usable fees go into this action. No fixed reserve.'
                        : `This cost estimate needs at least ${usd(Number(estimate.minimumFeesUsd))} in usable fees.`}
                    </p>
                  </div>
                  <dl className="dm-receipt">
                    <div>
                      <dt>Previously waiting</dt>
                      <dd>{usd(Number(position.reservesUsd))}</dd>
                    </div>
                    <div>
                      <dt>New fees you added</dt>
                      <dd>+ {usd(Number(fees))}</dd>
                    </div>
                    <div className="dm-receipt-total">
                      <dt>Total available</dt>
                      <dd>{usd(Number(estimate.availableFeesUsd))}</dd>
                    </div>
                    <div>
                      <dt>
                        Service fee · 2% of{' '}
                        {usd(Number(estimate.consumedFeesUsd))}
                      </dt>
                      <dd>{usd(Number(estimate.serviceFeeUsd))}</dd>
                    </div>
                    <div>
                      <dt>Reinvested in this card</dt>
                      <dd>{usd(Number(estimate.reinvestedUsd))}</dd>
                    </div>
                    <div>
                      <dt>Left waiting</dt>
                      <dd>{usd(Number(estimate.reserveUsd))}</dd>
                    </div>
                  </dl>
                  <p className="dm-small">
                    {estimate.decision === 'eligible'
                      ? 'The service fee covers the network cost. Waiting fees are charged only when used.'
                      : 'Nothing is charged while waiting. These fees remain available for the next check.'}{' '}
                    Exact amounts and the calculation appear in Activity.
                  </p>
                </>
              )}
              {position && !position.enabled && stage !== 'overview' && (
                <p role="alert" className="dm-error">
                  This card is paused. Go back to its overview to resume.
                </p>
              )}
              {error && (
                <p role="alert" className="dm-error">
                  {error}
                </p>
              )}
            </div>
            <footer className="dm-flow-footer">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  stage === 'overview'
                    ? setSelected('')
                    : go(stage === 'review' ? 'inputs' : 'overview')
                }
              >
                {stage !== 'overview' && <ArrowLeft />}
                {stage === 'overview' ? 'Close' : 'Back'}
              </Button>
              <Button
                disabled={
                  busy ||
                  !position?.enabled ||
                  (stage !== 'overview' && !estimate)
                }
                onClick={() =>
                  stage === 'review'
                    ? simulate()
                    : go(stage === 'overview' ? 'inputs' : 'review')
                }
              >
                {busy
                  ? 'Checking…'
                  : stage === 'overview'
                    ? 'Try reinvesting'
                    : stage === 'inputs'
                      ? 'Review scenario'
                      : 'Record simulation'}
                <ArrowRight />
              </Button>
            </footer>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
export function SettingsPanel({
  dark,
  onDark,
}: {
  dark: boolean;
  onDark: (value: boolean) => void;
}) {
  return (
    <>
      <div className="dm-page-title">
        <div>
          <h1>Your workspace</h1>
          <p className="dm-muted">A preview of the controls you will have.</p>
        </div>
      </div>
      <section className="dm-panel dm-settings">
        <div className="dm-setting">
          <div>
            <Label htmlFor="appearance">Dark appearance</Label>
            <p className="dm-small">Saved on this browser.</p>
          </div>
          <Switch id="appearance" checked={dark} onCheckedChange={onDark} />
        </div>
        <div className="dm-setting">
          <div>
            <h2>Compound</h2>
            <p className="dm-muted">
              Reinvest as much as economically viable. No fixed fee reserve.
              Waiting balances remain available for the next cost check.
            </p>
          </div>
          <span className="dm-status">Practice available</span>
        </div>
        <div className="dm-setting">
          <div>
            <h2>Fee-balancing swaps</h2>
            <p className="dm-muted">
              Use a swap when its expected benefit beats direct reinvestment and
              waiting, after costs. Fund it only with earned fees, within
              slippage and price-impact limits.
            </p>
          </div>
          <span className="dm-status">Planned</span>
        </div>
        <div className="dm-setting">
          <div>
            <h2>Domino</h2>
            <p className="dm-muted">
              Use fees to extend a sequence into another price range. Trigger
              distance and overlap will be independent controls.
            </p>
          </div>
          <span className="dm-status">Planned · advanced</span>
        </div>
        <div className="dm-setting">
          <div>
            <h2>Wallet permissions</h2>
            <p className="dm-muted">
              The practice workspace has no wallet access. Live setup, changes
              and withdrawals will require your wallet.
            </p>
          </div>
          <ShieldPermission />
        </div>
        <div className="dm-setting">
          <div>
            <h2>Service pricing</h2>
            <p className="dm-muted">
              Proposed 2% of eligible fees used, including ongoing gas. No
              charge on the initial deposit. Setup and exit gas are separate.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
function ShieldPermission() {
  return <span className="dm-status">Not connected</span>;
}
