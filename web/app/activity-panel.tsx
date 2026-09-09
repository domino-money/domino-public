'use client';
import { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  Check,
  Clock3,
  Layers3,
  Pause,
  Play,
  ReceiptText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from '@/components/ui/empty';
import { pendingFeesExplanation, moneyUnits } from '@/lib/compound';
import { practiceFunding, type PracticeBook } from '@/lib/practice';

type Tone = 'in' | 'out' | 'wait' | 'neutral';
function amountText(value: string, exact = false, tone: Tone = 'neutral') {
  const positive = moneyUnits(value) > 0n;
  // Keep sub-cent fees visible instead of displaying a misleading +$0.00.
  const digits = exact || (positive && Number(value) < 0.01) ? 6 : 2;
  const amount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value));
  return `${positive && tone === 'in' ? '+' : positive && tone === 'out' ? '−' : ''}${amount}`;
}
function Amount({
  value,
  tone = 'neutral',
  exact = false,
}: {
  value: string;
  tone?: Tone;
  exact?: boolean;
}) {
  return (
    <strong
      className={`dm-amount dm-amount-${moneyUnits(value) > 0n ? tone : 'neutral'}`}
    >
      {amountText(value, exact, tone)}
    </strong>
  );
}
function Metric({
  label,
  value,
  tone = 'neutral',
  exact = false,
}: {
  label: string;
  value: string;
  tone?: Tone;
  exact?: boolean;
}) {
  return (
    <div
      className={`dm-money-tile dm-money-tile-${moneyUnits(value) > 0n ? tone : 'neutral'}`}
    >
      <span>{label}</span>
      <Amount value={value} tone={tone} exact={exact} />
    </div>
  );
}
const date = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function ActivityPanel({ book }: { book: PracticeBook }) {
  const [selected, setSelected] = useState(''),
    [view, setView] = useState('amounts'),
    [exact, setExact] = useState(false);
  const event = book.events.find((e) => e.id === selected),
    d = event?.decision;
  const funding = event ? practiceFunding(book, event) : undefined;
  const number = event
    ? book.positions.findIndex((p) => p.id === event.positionId) + 1
    : 0;
  return (
    <>
      <div className="dm-page-title">
        <div>
          <h1>Your activity, at a glance.</h1>
          <p className="dm-muted">
            Practice history · simulated amounts, no real transactions.
          </p>
        </div>
      </div>
      {!book.events.length ? (
        <Empty className="dm-panel dm-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ReceiptText />
            </EmptyMedia>
            <EmptyTitle>No activity yet.</EmptyTitle>
            <EmptyDescription>
              Your position setup and fee scenarios will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Dialog
          open={!!d}
          onOpenChange={(open) => {
            if (!open) setSelected('');
          }}
        >
          <div className="dm-history-grid">
            {book.events.map((item) => {
              const decision = item.decision,
                ready = decision?.decision === 'eligible';
              const card =
                book.positions.findIndex((p) => p.id === item.positionId) + 1;
              const Icon = decision
                ? ready
                  ? ArrowDownLeft
                  : Clock3
                : item.kind === 'created'
                  ? Layers3
                  : item.kind === 'paused'
                    ? Pause
                    : Play;
              return (
                <article
                  className={`dm-history-card ${decision ? '' : 'dm-history-note'}`}
                  key={item.id}
                >
                  <div className="dm-history-heading">
                    <span
                      className={`dm-history-icon ${decision ? (ready ? 'dm-tone-in' : 'dm-tone-wait') : ''}`}
                    >
                      <Icon size={19} aria-hidden="true" />
                    </span>
                    <div>
                      <h2>
                        {decision
                          ? ready
                            ? 'Reinvestment'
                            : 'Waiting to reinvest'
                          : item.kind === 'created'
                            ? 'Position created'
                            : item.kind === 'paused'
                              ? 'Practice paused'
                              : 'Practice resumed'}
                      </h2>
                      <p>
                        Card {card} ·{' '}
                        <time dateTime={item.at}>
                          {date.format(new Date(item.at))}
                        </time>
                      </p>
                    </div>
                  </div>
                  {decision ? (
                    <>
                      <div
                        className={`dm-history-result ${ready ? 'dm-tone-in' : 'dm-tone-wait'}`}
                      >
                        <span>
                          {ready
                            ? 'Added to this position'
                            : 'Fees kept for later'}
                        </span>
                        <Amount
                          value={
                            ready ? decision.reinvestedUsd : decision.reserveUsd
                          }
                          tone={ready ? 'in' : 'wait'}
                        />
                      </div>
                      <div className="dm-money-grid">
                        <Metric
                          label={ready ? 'Fees used' : 'Reinvested'}
                          value={
                            ready
                              ? decision.consumedFeesUsd
                              : decision.reinvestedUsd
                          }
                        />
                        <Metric
                          label="Service fee"
                          value={decision.serviceFeeUsd}
                          tone="out"
                        />
                      </div>
                      <div className="dm-history-bottom">
                        <div>
                          {ready ? (
                            <>
                              <span>Still waiting</span>
                              <Amount value={decision.reserveUsd} tone="wait" />
                            </>
                          ) : (
                            <span className="dm-history-reason">
                              {decision.reason === 'no_fees'
                                ? 'No fees available yet.'
                                : 'Network cost is too high.'}
                              <strong>No fee charged.</strong>
                            </span>
                          )}
                        </div>
                        <DialogTrigger
                          render={
                            <Button
                              variant="ghost"
                              aria-label={`View receipt for card ${card}, ${date.format(new Date(item.at))}`}
                              onClick={() => {
                                setSelected(item.id);
                                setView('amounts');
                                setExact(false);
                              }}
                            />
                          }
                        >
                          View receipt <ArrowRight />
                        </DialogTrigger>
                      </div>
                    </>
                  ) : (
                    <p className="dm-history-note-copy">
                      {item.kind === 'created'
                        ? 'Saved to this browser. No funds deposited.'
                        : item.kind === 'paused'
                          ? 'Reinvestment is paused. Liquidity and token exposure stay in place.'
                          : 'Ready to try another reinvestment scenario.'}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
          <DialogContent className="dm-flow dm-receipt-dialog">
            <header className="dm-flow-header">
              <p className="dm-eyebrow">CARD {number} · PRACTICE RECEIPT</p>
              <DialogTitle className="dm-flow-title">
                {d?.decision === 'eligible'
                  ? 'Your fees, accounted for.'
                  : 'Waiting for a better moment.'}
              </DialogTitle>
              <DialogDescription>
                {event && date.format(new Date(event.at))} · Simulation only
              </DialogDescription>
            </header>
            <Tabs
              className="dm-receipt-tabs"
              value={view}
              onValueChange={setView}
            >
              <TabsList aria-label="Receipt details">
                <TabsTrigger value="amounts">Amounts</TabsTrigger>
                <TabsTrigger value="costs">Costs</TabsTrigger>
                <TabsTrigger value="decision">Why this action?</TabsTrigger>
              </TabsList>
              <div className="dm-receipt-content">
                {d && (
                  <>
                    <TabsContent value="amounts" className="dm-receipt-tab">
                      <div className="dm-money-grid">
                        {funding ? (
                          <>
                            <Metric
                              label="Already waiting"
                              value={funding.waitingFeesUsd}
                              tone="wait"
                              exact={exact}
                            />
                            <Metric
                              label="New fees added"
                              value={funding.newFeesUsd}
                              tone="in"
                              exact={exact}
                            />
                          </>
                        ) : (
                          <p className="dm-receipt-unavailable">
                            The new / waiting split is unavailable in this older
                            record. Its recorded totals are preserved below.
                          </p>
                        )}
                      </div>
                      <div className="dm-money-total">
                        <span>Total available</span>
                        <Amount value={d.availableFeesUsd} exact={exact} />
                      </div>
                      <div className="dm-money-grid">
                        <Metric
                          label="Added to this position"
                          value={d.reinvestedUsd}
                          tone="in"
                          exact={exact}
                        />
                        <Metric
                          label="Service fee deducted"
                          value={d.serviceFeeUsd}
                          tone="out"
                          exact={exact}
                        />
                      </div>
                      <div className="dm-money-total dm-waiting-total">
                        <span>Still waiting</span>
                        <Amount
                          value={d.reserveUsd}
                          tone="wait"
                          exact={exact}
                        />
                      </div>
                      <p className="dm-small">
                        Waiting fees stay available.{' '}
                        <strong>They are charged only when used.</strong>
                      </p>
                    </TabsContent>
                    <TabsContent value="costs" className="dm-receipt-tab">
                      <section className="dm-service-calculation">
                        <span>Service fee</span>
                        <Amount
                          value={d.serviceFeeUsd}
                          tone="out"
                          exact={exact}
                        />
                        <p>
                          <strong>2%</strong> ×{' '}
                          <strong>
                            {amountText(d.consumedFeesUsd, exact)}
                          </strong>{' '}
                          of fees used
                        </p>
                      </section>
                      <div className="dm-money-grid">
                        <Metric
                          label={
                            d.decision === 'eligible'
                              ? 'Gas paid from the service fee'
                              : 'Estimated gas if executed'
                          }
                          value={d.gasUsd}
                          exact={exact}
                        />
                        <Metric
                          label="Service keeps after gas"
                          value={d.operatorMarginUsd}
                          exact={exact}
                        />
                      </div>
                      <div className="dm-receipt-message">
                        <Check size={18} aria-hidden="true" />
                        <p>
                          {d.decision === 'eligible' ? (
                            <>
                              <strong>
                                Gas is included in the service fee.
                              </strong>{' '}
                              It is not a second deduction from your fees.
                            </>
                          ) : (
                            <>
                              <strong>
                                No service fee or gas was charged.
                              </strong>{' '}
                              Gas is an estimate for a future action.
                            </>
                          )}
                        </p>
                      </div>
                      <p className="dm-small">
                        Amounts are simulated in USD.{' '}
                        {exact
                          ? 'Six decimal places shown.'
                          : 'Rounded for readability; enable exact amounts for the full calculation.'}{' '}
                        The service fee is rounded down to the nearest
                        $0.000001.
                      </p>
                    </TabsContent>
                    <TabsContent value="decision" className="dm-receipt-tab">
                      <section className="dm-reason-card">
                        <span
                          className={`dm-history-icon ${d.decision === 'eligible' ? 'dm-tone-in' : 'dm-tone-wait'}`}
                        >
                          {d.decision === 'eligible' ? (
                            <Check size={19} />
                          ) : (
                            <Clock3 size={19} />
                          )}
                        </span>
                        <div>
                          <h3>
                            {d.decision === 'eligible'
                              ? 'The cost check passed.'
                              : d.reason === 'no_fees'
                                ? 'No fees to reinvest yet.'
                                : 'The network cost is too high.'}
                          </h3>
                          <p>
                            {d.decision === 'eligible' ? (
                              <>
                                The 2% service fee covers gas with a{' '}
                                <strong>15% cost buffer</strong>.
                              </>
                            ) : d.reason === 'no_fees' ? (
                              'Add hypothetical fees to try another scenario.'
                            ) : (
                              <>
                                This estimate needs at least{' '}
                                <strong>
                                  {amountText(d.minimumFeesUsd, true)}
                                </strong>{' '}
                                in usable fees. Recheck when fees or gas change.
                              </>
                            )}
                          </p>
                        </div>
                      </section>
                      <section className="dm-reason-card">
                        <Layers3 size={19} aria-hidden="true" />
                        <div>
                          <h3>Same position · Card {number}</h3>
                          <p>
                            {d.decision === 'eligible'
                              ? 'The reinvested amount was added to this practice position.'
                              : 'When the check passes, fees can be reinvested in this practice position.'}
                          </p>
                        </div>
                      </section>
                      <section className="dm-policy-card">
                        <h3>
                          {d.policyVersion === 2
                            ? 'Use all eligible fees.'
                            : 'Older policy · 15% addition limit'}
                        </h3>
                        <p>
                          {d.policyVersion === 2
                            ? 'No fixed percentage is held back. '
                            : 'This receipt retains the former limit on net additions. '}
                          {pendingFeesExplanation(d)}
                        </p>
                      </section>
                      <p className="dm-small">
                        <strong>Transaction hash:</strong> none — simulation
                        only.
                      </p>
                    </TabsContent>
                  </>
                )}
              </div>
            </Tabs>
            <footer className="dm-flow-footer">
              <div className="dm-precision-control">
                <Switch
                  id="receipt-exact"
                  checked={exact}
                  onCheckedChange={setExact}
                />
                <Label htmlFor="receipt-exact">Exact amounts</Label>
              </div>
              <Button variant="outline" onClick={() => setSelected('')}>
                Done
              </Button>
            </footer>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
