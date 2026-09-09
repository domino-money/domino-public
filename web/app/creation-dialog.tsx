'use client';
import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, MoveHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { addPracticePosition } from '@/lib/practice';
import type { BookUpdate } from '@/lib/local-workspace';
import {
  previewPosition,
  usd,
  qty,
  type PositionPreview,
} from '@/lib/position';

const labels = ['Amount', 'Range', 'Explore', 'Review'];
const titles = [
  'Start with a token you know.',
  'Give your token room to move.',
  'What if the price moves?',
  'Your position, ready to try.',
];
const descriptions = [
  'Try MEME / USDG with a hypothetical starting value.',
  'Your position can earn trading fees while the price is in this range.',
  'Move the price to see how your two assets change.',
  'Check the setup. This creates a local practice card.',
];
export function CreationDialog({
  open,
  onOpenChange,
  setBook,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setBook: (update: BookUpdate) => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState(0),
    [amount, setAmount] = useState('1000');
  const [range, setRange] = useState('standard'),
    [price, setPrice] = useState(1);
  const [understood, setUnderstood] = useState(false),
    [error, setError] = useState('');
  const saving = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const lower = range === 'wide' ? 0.5 : 0.7,
    upper = range === 'wide' ? 2 : 1.5;
  let result: PositionPreview | null = null;
  try {
    result = previewPosition({
      amount: Number(amount),
      lower,
      upper,
      startingPrice: 1,
      scenarioPrice: price,
    });
  } catch {}
  function go(next: number) {
    setStep(next);
    setError('');
    requestAnimationFrame(() => heading.current?.focus());
  }
  function create() {
    if (!result || !understood || saving.current) return;
    saving.current = true;
    try {
      const position = {
        id: 'practice-' + crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        amount: Number(amount),
        lower,
        upper,
        enabled: true,
        reservesUsd: '0.000000',
        feesAddedUsd: '0.000000',
        netAddedUsd: '0.000000',
        servicePaidUsd: '0.000000',
      };
      const eventId = crypto.randomUUID();
      setBook((previous) => addPracticePosition(previous, position, eventId));
      onCreated();
      onOpenChange(false);
      setStep(0);
      setUnderstood(false);
      setPrice(1);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not save this practice position.',
      );
    } finally {
      saving.current = false;
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="dm-flow">
        <header className="dm-flow-header">
          <p className="dm-eyebrow">NEW POSITION · PRACTICE</p>
          <DialogTitle ref={heading} tabIndex={-1} className="dm-flow-title">
            {titles[step]}
          </DialogTitle>
          <DialogDescription>{descriptions[step]}</DialogDescription>
          <ol className="dm-steps" aria-label="Creation progress">
            {labels.map((label, i) => (
              <li
                key={label}
                className={i <= step ? 'active' : ''}
                aria-current={i === step ? 'step' : undefined}
              >
                <span>{i < step ? <Check size={12} /> : i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
        </header>
        <div className="dm-flow-body">
          {step === 0 && (
            <>
              <div className="dm-pair">
                <div className="dm-avatars" aria-hidden="true">
                  <span>M</span>
                  <span>$</span>
                </div>
                <div>
                  <h2>MEME / USDG</h2>
                  <p className="dm-small">
                    Example pair · MEME starts at $1.00
                  </p>
                </div>
              </div>
              <Label htmlFor="amount">Total starting value</Label>
              <div className="dm-money-input">
                <span>$</span>
                <Input
                  id="amount"
                  type="number"
                  min={10}
                  max={1000000}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-describedby="amount-hint"
                  aria-invalid={!result}
                />
                <span>USD</span>
              </div>
              <p id="amount-hint" className={result ? 'dm-small' : 'dm-error'}>
                {result
                  ? 'The combined value of both assets, before setup costs.'
                  : 'Enter an amount between $10 and $1,000,000.'}
              </p>
              <div className="dm-callout">
                <strong>Two assets. One position.</strong>
                <p>
                  You provide MEME and USDG for others to trade between. Your
                  share of trading fees can be reinvested.
                </p>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <RadioGroup
                aria-label="Price range"
                className="dm-range-options"
                value={range}
                onValueChange={(v) => {
                  setRange(v);
                  setUnderstood(false);
                }}
              >
                {[
                  ['standard', 'Closer range', '$0.70 – $1.50'],
                  ['wide', 'Wider range', '$0.50 – $2.00'],
                ].map(([key, title, prices]) => (
                  <label
                    key={key}
                    className={
                      'dm-range-option ' + (range === key ? 'selected' : '')
                    }
                  >
                    <RadioGroupItem value={key} />
                    <span>
                      {title}
                      <strong>{prices}</strong>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              <p className="dm-small">
                A wider range covers more prices and spreads your liquidity
                further. Neither range guarantees a return.
              </p>
              <div className="dm-callout">
                <strong>Your starting mix</strong>
                <p>
                  {result ? qty(result.initialToken) : '—'} MEME +{' '}
                  {result ? qty(result.initialStable) : '—'} USDG
                </p>
                <p className="dm-small">
                  A live setup would show any required swap and its cost before
                  you sign.
                </p>
              </div>
            </>
          )}
          {step === 2 && result && (
            <>
              <div className="dm-price-heading">
                <Label htmlFor="scenario-price">MEME scenario price</Label>
                <strong>{usd(price)}</strong>
              </div>
              <Slider
                id="scenario-price"
                aria-label="MEME scenario price"
                min={0.4}
                max={2.2}
                step={0.01}
                value={[price]}
                onValueChange={(v) => setPrice(Array.isArray(v) ? v[0] : v)}
              />
              <div className="dm-slider-ends">
                <span>$0.40</span>
                <span>
                  <MoveHorizontal size={14} /> Try moving the price
                </span>
                <span>$2.20</span>
              </div>
              <div className="dm-mix-bar" aria-hidden="true">
                <span style={{ width: `${result.tokenShare * 100}%` }} />
                <span style={{ flex: 1 }} />
              </div>
              <div className="dm-mix-labels">
                <span>
                  <i className="dm-token-dot" />
                  {qty(result.token)} MEME
                </span>
                <span>
                  <i className="dm-stable-dot" />
                  {qty(result.stable)} USDG
                </span>
              </div>
              <p className="dm-explanation">
                {result.status === 'inside'
                  ? 'In range. As the price rises, MEME becomes USDG; as it falls, USDG becomes MEME.'
                  : result.status === 'above'
                    ? 'Above your range. Your position is all USDG and earns no trading fees until the price returns.'
                    : 'Below your range. Your position is all MEME and earns no trading fees until the price returns.'}
              </p>
              <div className="dm-comparison">
                <div>
                  <span>Position value</span>
                  <strong>{usd(result.value)}</strong>
                </div>
                <div>
                  <span>Holding the initial assets</span>
                  <strong>{usd(result.holdValue)}</strong>
                </div>
              </div>
              <p className="dm-small">
                Price-only illustration, USDG = $1. Fees, gas, swaps and
                reinvestment are excluded. Exploring a price does not change
                your $1 starting price.
              </p>
            </>
          )}
          {step === 3 && result && (
            <>
              <div className="dm-review-pair">
                <div className="dm-avatars" aria-hidden="true">
                  <span>M</span>
                  <span>$</span>
                </div>
                <h2>MEME / USDG</h2>
                <span className="dm-status">Practice</span>
              </div>
              <dl className="dm-receipt">
                <div>
                  <dt>Starting value</dt>
                  <dd>{usd(Number(amount))}</dd>
                </div>
                <div>
                  <dt>Range</dt>
                  <dd>
                    {usd(lower)} – {usd(upper)}
                  </dd>
                </div>
                <div>
                  <dt>Starting mix</dt>
                  <dd>
                    {qty(result.initialToken)} MEME
                    <br />
                    {qty(result.initialStable)} USDG
                  </dd>
                </div>
                <div>
                  <dt>Service fee on reinvestment</dt>
                  <dd>2% of fees used</dd>
                </div>
              </dl>
              <label className="dm-consent" htmlFor="practice-risk-consent">
                <Checkbox
                  id="practice-risk-consent"
                  checked={understood}
                  onCheckedChange={(v) => setUnderstood(v === true)}
                />
                <span>
                  I understand the token mix changes with price, losses are
                  possible, and fees stop outside the range.
                </span>
              </label>
              <p className="dm-small">
                No deposit, wallet signature or service charge. Reinvestment
                scenarios are run manually in practice mode.
              </p>
            </>
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
            onClick={() => (step ? go(step - 1) : onOpenChange(false))}
          >
            {step ? <ArrowLeft /> : null}
            {step ? 'Back' : 'Close'}
          </Button>
          <Button
            onClick={() => (step === 3 ? create() : go(step + 1))}
            disabled={!result || (step === 3 && !understood)}
          >
            {step === 3 ? 'Create practice card' : 'Continue'}
            <ArrowRight />
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
