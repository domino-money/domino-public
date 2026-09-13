/**
 * The fixture lab's scenarios: what the fixture transport answers, in order,
 * for what the flow will ask. Each variant of the package is one scenario;
 * so is each derived fixture and each behaviour the ACK asks to see (admission
 * denial, owner binding, conflicts, two tabs, boot reconciliation).
 *
 * Replies of package fixtures are their raw text, byte for byte, so a wallet
 * step reaches the screen exactly as the package ships it.
 */
import { reply, type FixtureTransport } from '../fixtureTransport'
import type { DepositResponses } from '../types'
import { DERIVED, OPERATION_ID, VARIANTS, advancedAfterApproval, beforeIssue, foreignGet, foreignList, listBody, pagedList, parsed, singleOf, withId, withoutStep, type FixtureSource, type VariantName } from './derive'

type Single = DepositResponses['get']

export interface Scenario {
  id: string
  label: string
  group: 'Package variants' | 'Derived fixtures' | 'Behaviour'
  description: string
  /** Scripts the transport for the boot and for the actions this scenario is about. */
  script(transport: FixtureTransport): void
  /** The operation id the lab's in-memory store starts with. */
  remembered: string | null
  /** 'http' simulates the live transport kind with no wallet handoff: Prepare must be off. */
  transportKind: 'fixture' | 'http'
  /** A lab-only control that runs one user action this scenario is about. */
  labAction?: { label: string; action: 'allowances' }
}

const STEP_VARIANTS: ReadonlySet<VariantName> = new Set(['erc20_approval', 'erc20_reset', 'mint', 'native', 'permit2_approval', 'reviewed-proxy'])

const ok = (body: unknown) => reply(200, body)
const err = (code: string, status: number) => reply(status, { error: code })

/** list, get (the remembered operation) and, for an outstanding one, its boot reconcile. */
function boot(transport: FixtureTransport, body: Single, raw?: string) {
  transport.script('list', ok(listBody([body.operation])))
  transport.script('get', ok(raw ?? body))
  if (body.operation.outstanding) transport.script('reconcile', ok(raw ?? body))
}

function variantScenario(source: FixtureSource, name: VariantName): Scenario {
  const text = source.text(`variants/${name}.json`)
  const body = parsed(source, `variants/${name}.json`)
  const step = STEP_VARIANTS.has(name)
  return {
    id: `variant:${name}`,
    label: name,
    group: 'Package variants',
    description: step
      ? `variants/${name}.json. The operation boots in draft, as it stood before this step was issued; Prepare returns the package's prepare response unchanged, a fresh issuance whose handoff window the page counts from its own request.`
      : `variants/${name}.json, as the service would return it for this operation.`,
    remembered: OPERATION_ID,
    transportKind: 'fixture',
    script(transport) {
      if (step) {
        boot(transport, beforeIssue(body))
        transport.script('prepare', ok(text))
      } else if (name === 'partial_allowances') {
        boot(transport, singleOf(body))
        transport.script('allowances', ok(text))
      } else {
        boot(transport, body, text)
      }
      transport.script('allowances', ok(allowancesFor(source, body)))
    },
    ...(name === 'partial_allowances' ? { labAction: { label: 'Load the allowance fixture', action: 'allowances' as const } } : {}),
  }
}

/** An allowances answer for any operation: the package's partial report around it. */
function allowancesFor(source: FixtureSource, body: Single): DepositResponses['allowances'] {
  const report = parsed<DepositResponses['allowances']>(source, 'variants/partial_allowances.json')
  // One observation per non-native currency of this operation's pool, in PoolKey order.
  const { currency0, currency1 } = body.operation.selection.poolKey
  const wanted = [currency0, currency1].filter((currency) => currency !== '0x0000000000000000000000000000000000000000')
  const observations = wanted.map((currency, i) => ({ ...report.allowances.observations[i], currency }))
  return { ...report, allowances: { ...report.allowances, observations }, operation: withoutStep(body).operation }
}

function derivedScenario(source: FixtureSource, id: string): Scenario {
  const entry = DERIVED[id]
  const body = entry.build(source)
  return {
    id: `derived:${id}`,
    label: entry.label,
    group: 'Derived fixtures',
    description: `Derived from a package fixture (${id}): it passes the pinned runtime and follows a producer transition; a synthetic display case, not a qualification.`,
    remembered: OPERATION_ID,
    transportKind: 'fixture',
    script(transport) {
      boot(transport, body)
      transport.script('allowances', ok(allowancesFor(source, body)))
    },
  }
}

function behaviourScenarios(source: FixtureSource): Scenario[] {
  const draft = parsed(source, 'responses/get.json')
  const mintText = source.text('variants/mint.json')
  const reserved = withoutStep(parsed(source, 'variants/mint.json'))
  const pending = withoutStep(parsed(source, 'variants/pending.json'))
  const conflict = parsed(source, 'variants/reported_nonce_conflict.json')
  const confirmed = parsed(source, 'variants/confirmed.json')
  const blocker = withId(pending, '00000000-0000-4000-8000-000000000050')
  const scenario = (s: Omit<Scenario, 'group' | 'remembered' | 'transportKind'> & Partial<Pick<Scenario, 'remembered' | 'transportKind'>>): Scenario => ({
    group: 'Behaviour',
    remembered: OPERATION_ID,
    transportKind: 'fixture',
    ...s,
  })
  return [
    scenario({
      id: 'admission-denied',
      label: 'Prepare refused: admission required',
      description: 'A draft whose first Prepare is refused with deposit_admission_required. Prepare latches off; nothing is retried, no new mint or deposit is attempted.',
      script(transport) {
        boot(transport, draft)
        transport.script('prepare', err('deposit_admission_required', 422))
      },
    }),
    scenario({
      id: 'token-changed',
      label: 'Re-open refused: token changed',
      description: 'A reserved slot whose re-delivery is refused with deposit_token_changed. Stopped; the reservation stays held; Prepare latches off.',
      script(transport) {
        boot(transport, reserved)
        transport.script('prepare', err('deposit_token_changed', 409))
      },
    }),
    scenario({
      id: 'artifact-expired',
      label: 'Re-open refused: handoff expired',
      description: 'A reserved slot whose re-delivery is refused with deposit_artifact_expired. The reservation is still held.',
      script(transport) {
        boot(transport, reserved)
        transport.script('prepare', err('deposit_artifact_expired', 409))
      },
    }),
    scenario({
      id: 'allowances-newer-operation',
      label: 'Check allowances after another tab moved on',
      description:
        'An approval step is prepared here (version 2, nonce 5). Check allowances then answers with the operation as another tab left it: the approval confirmed and a Permit2 step issued at nonce 6 (version 5). The page drops the step it held, with its deadline and pre-sign checks.',
      script(transport) {
        boot(transport, beforeIssue(parsed(source, 'variants/erc20_approval.json')))
        transport.script('prepare', ok(source.text('variants/erc20_approval.json')))
        transport.script('allowances', ok(allowancesFor(source, advancedAfterApproval(source))))
      },
    }),
    scenario({
      id: 'redelivery-after-reload',
      label: 'Re-open after a reload: validity unknown',
      description:
        "A reserved slot this page did not issue (as after a reload). Re-open returns the same step with its original expiration; the page cannot tell how much of its window is left, so it never shows it as fresh or offers it for review.",
      script(transport) {
        boot(transport, reserved)
        transport.script('prepare', ok(mintText))
      },
    }),
    scenario({
      id: 'session-required',
      label: 'Prepare refused: session ended',
      description: 'The service answers session_required. The session port is told (recorded here); nothing is retried.',
      script(transport) {
        boot(transport, draft)
        transport.script('prepare', err('session_required', 401))
      },
    }),
    scenario({
      id: 'owner-busy',
      label: 'Prepare refused: another deposit is open',
      description: 'deposit_owner_busy while another operation is outstanding: the screen points at it and offers nothing else.',
      script(transport) {
        transport.script('list', ok(listBody([draft.operation, blocker.operation])))
        transport.script('get', ok(draft))
        transport.script('reconcile', ok(blocker))
        transport.script('prepare', err('deposit_owner_busy', 409))
        transport.script('get', ok(blocker))
      },
    }),
    scenario({
      id: 'version-conflict',
      label: 'Two tabs: cancel meets a version conflict',
      description: 'Cancel is refused with deposit_version_conflict; the flow reads the operation once and shows it. The cancel is not sent again.',
      script(transport) {
        boot(transport, draft)
        transport.script('cancel', err('deposit_version_conflict', 409))
        transport.script('get', ok(parsed(source, 'variants/cancelled.json')))
      },
    }),
    scenario({
      id: 'foreign-get',
      label: 'Owner binding: an answer about another account',
      description: "The remembered operation comes back owned by another address. It passes the package runtime; the client refuses it, forgets the id and shows nothing of it.",
      script(transport) {
        transport.script('list', ok(listBody([confirmed.operation])))
        transport.script('get', ok(foreignGet(source)))
        transport.script('get', ok(foreignGet(source)))
      },
    }),
    scenario({
      id: 'foreign-list',
      label: 'Owner binding: a list naming another account',
      description: 'The first list page names another owner. The whole page is refused; nothing is listed or reconciled.',
      remembered: null,
      script(transport) {
        transport.script('list', ok(foreignList(source)))
      },
    }),
    scenario({
      id: 'boot-reconcile',
      label: 'Reload: only outstanding deposits are reconciled',
      description: 'The first page holds a pending, a confirmed, a draft and a cancelled deposit. Boot reconciles the pending one only, once, with its own version.',
      remembered: null,
      script(transport) {
        const other = (name: 'confirmed' | 'cancelled', id: string) => withId(withoutStep(parsed(source, `variants/${name}.json`)), id).operation
        const pendingOp = withId(pending, '00000000-0000-4000-8000-000000000051')
        transport.script(
          'list',
          ok(listBody([pendingOp.operation, other('confirmed', '00000000-0000-4000-8000-000000000052'), withId(draft, '00000000-0000-4000-8000-000000000053').operation, other('cancelled', '00000000-0000-4000-8000-000000000054')])),
        )
        transport.script('reconcile', ok(pendingOp))
      },
    }),
    scenario({
      id: 'support-conflict',
      label: 'Off-nonce conflict: support required',
      description: 'variants/reported_nonce_conflict.json: shown as support-required, with no retry, cancel, dismiss or new-deposit control.',
      script(transport) {
        boot(transport, conflict)
      },
    }),
    scenario({
      id: 'unresolved',
      label: 'Unresolved hash: support required',
      description: 'An operation in attention after a check that could not identify the reported transaction. Shown as support-required.',
      script(transport) {
        boot(transport, DERIVED.attention_transient.build(source))
      },
    }),
    scenario({
      id: 'report-hash',
      label: 'Report a transaction hash',
      description: 'A reserved slot; the user reports a hash, which moves it to pending. The hash is only a hint.',
      script(transport) {
        boot(transport, reserved)
        transport.script('report', ok(pending))
      },
    }),
    scenario({
      id: 'http-activation',
      label: 'Live transport kind, no wallet handoff',
      description: 'The flow believes it talks to the live service and has no wallet handoff: Prepare and Re-open stay off, with the reservation explained.',
      transportKind: 'http',
      script(transport) {
        boot(transport, reserved)
        transport.script('prepare', ok(mintText))
      },
    }),
    scenario({
      id: 'list-more',
      label: 'List pagination',
      description: 'A first page that says there is more, and the page after it.',
      remembered: null,
      script(transport) {
        const { first, second } = pagedList(source)
        transport.script('list', ok(first), ok(second))
      },
    }),
  ]
}

export function scenarios(source: FixtureSource): Scenario[] {
  return [
    ...VARIANTS.map((name) => variantScenario(source, name)),
    ...Object.keys(DERIVED).map((id) => derivedScenario(source, id)),
    ...behaviourScenarios(source),
  ]
}
