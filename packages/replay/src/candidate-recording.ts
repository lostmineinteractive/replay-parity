import {
  RecordingWriter,
  bodyFieldsOf,
  redactHeaders,
  type Exchange,
  type RecordedRequest,
  type RecordedResponse,
} from '@replay-parity/core';

/**
 * The candidate's observed log: every request as sent and the candidate's
 * response, in send order, in the recording format. Exchange ids and tags
 * are the reference recording's, so the two files line up by id.
 */
export interface SentExchange {
  exchange: Exchange;
  request: RecordedRequest;
  /** `null` when the send failed. Failed sends are left out of the file. */
  response: RecordedResponse | null;
  /** Milliseconds since the run started. */
  sentAtMs: number;
  /** Wall clock time of the send. */
  sentWallMs: number;
}

export interface CandidateRecordingOptions {
  sent: readonly SentExchange[];
  adapter: string;
  redactHeaders: readonly string[];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function candidateExchanges(options: CandidateRecordingOptions): Exchange[] {
  const ordered = options.sent
    .filter((s) => s.response !== null)
    .sort((a, b) => a.sentAtMs - b.sentAtMs);
  const first = ordered[0]?.sentAtMs ?? 0;
  return ordered.map((s) => {
    const response = s.response as RecordedResponse;
    return {
      id: s.exchange.id,
      ts: new Date(s.sentWallMs).toISOString(),
      offset_ms: round3(s.sentAtMs - first),
      adapter: options.adapter,
      request: {
        method: s.request.method,
        path: s.request.path,
        query: s.request.query,
        headers: redactHeaders(s.request.headers, options.redactHeaders),
        ...bodyFieldsOf(s.request),
      },
      response: {
        status: response.status,
        headers: redactHeaders(response.headers, options.redactHeaders),
        latency_ms: response.latency_ms,
        ...bodyFieldsOf(response),
      },
      tags: [...s.exchange.tags],
    };
  });
}

/** Writes exchanges as a new recording file and returns how many were written. */
export async function writeExchanges(
  path: string,
  exchanges: readonly Exchange[],
): Promise<number> {
  const writer = await RecordingWriter.open(path, { append: false });
  try {
    for (const exchange of exchanges) await writer.write(exchange);
  } finally {
    await writer.close();
  }
  return writer.count;
}

export function writeCandidateRecording(
  path: string,
  options: CandidateRecordingOptions,
): Promise<number> {
  return writeExchanges(path, candidateExchanges(options));
}
