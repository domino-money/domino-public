import { previewCompound } from '@/lib/compound';
export async function POST(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return Response.json({ error: 'JSON required' }, { status: 415 });
  try {
    const reader = request.body?.getReader();
    if (!reader)
      return Response.json({ error: 'Missing body' }, { status: 400 });
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        return Response.json({ error: 'Request too large' }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const input = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !input ||
      Object.keys(input).sort().join(',') !==
        'availableFeesUsd,gasUsd,positionValueUsd'
    )
      throw Error('Invalid input fields.');
    return Response.json(previewCompound(input), {
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return Response.json(
      {
        error:
          'Invalid scenario. Use decimal strings for fees, position value and gas.',
      },
      { status: 422 },
    );
  }
}
