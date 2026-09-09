export function GET() {
  return Response.json(
    {
      version: 1,
      mode: 'practice',
      chainId: 4663,
      signingEnabled: false,
      walletFundingEnabled: false,
      liveDataEnabled: false,
      swapsEnabled: false,
      simulation: {
        protocolFeeBps: 200,
        reinvestmentPolicyVersion: 2,
        fixedReserveBps: 0,
        maxLiquidityIncreaseBps: null,
        gasBufferBps: 1500,
      },
      features: [
        'position-preview',
        'compound-preview',
        'local-practice-workspace',
      ],
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
