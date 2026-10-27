import { RecordingWriter, type Exchange, type KeptCase } from '@replay-parity/core';
import type { SideResult } from './execute.js';

/**
 * Kept cases as a recording, so the next `rp replay` includes them and a
 * divergence the agent found is checked from then on. One exchange per
 * step, in case order. The request is the one sent to the reference with
 * captures resolved, except that a redacted header keeps its marker instead
 * of being dropped and caller supplied headers are left out, the way a
 * capture would store it. The response is the reference's. Offsets start
 * at zero and grow by each step's reference latency, and `ts` is the run's
 * creation time plus the offset. The tags are the case's tags plus
 * `agent:<case id>`, so a replay can be filtered to one case.
 */
export interface KeptExecution {
  kept: KeptCase;
  reference: SideResult;
}

export function casesToExchanges(createdAt: string, kept: readonly KeptExecution[]): Exchange[] {
  const base = Date.parse(createdAt);
  const out: Exchange[] = [];
  let offset = 0;
  for (const { kept: c, reference } of kept) {
    for (let i = 0; i < reference.responses.length; i += 1) {
      const request = reference.requests[i];
      const response = reference.responses[i];
      if (request === undefined || response === undefined) break;
      out.push({
        id: `${c.id}:${i + 1}`,
        ts: new Date(base + offset).toISOString(),
        offset_ms: offset,
        adapter: 'http',
        request,
        response,
        tags: [...c.tags, `agent:${c.id}`],
      });
      offset += response.latency_ms;
    }
  }
  return out;
}

/** Writes the exchanges through the validating writer, replacing the file. Returns the count. */
export async function writeCaseRecording(
  path: string,
  exchanges: readonly Exchange[],
): Promise<number> {
  const writer = await RecordingWriter.open(path, { append: false });
  try {
    for (const exchange of exchanges) await writer.write(exchange);
  } finally {
    await writer.close();
  }
  return exchanges.length;
}
