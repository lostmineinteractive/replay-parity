import type { Writable } from 'node:stream';

/** Where a command writes. Tests pass buffers; the binary passes the process streams. */
export interface CliStreams {
  stdout: Writable;
  stderr: Writable;
}

export function out(streams: CliStreams, text: string): void {
  streams.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function err(streams: CliStreams, text: string): void {
  streams.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}
