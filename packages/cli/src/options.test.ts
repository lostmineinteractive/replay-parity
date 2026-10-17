import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fraction, parseFilter, parseListen, positiveInt, resolveHeaders } from './options.js';

describe('option parsers', () => {
  it('parses listen addresses', () => {
    expect(parseListen(':8080')).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(parseListen('8080')).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(parseListen('127.0.0.1:9000')).toEqual({ host: '127.0.0.1', port: 9000 });
    expect(() => parseListen('nope')).toThrow(/\[host\]:port/);
    expect(() => parseListen(':70000')).toThrow(/\[host\]:port/);
  });

  it('parses the filter and numbers', () => {
    expect(parseFilter('tag=create-order')).toBe('create-order');
    expect(() => parseFilter('create-order')).toThrow(/tag=<name>/);
    expect(positiveInt('4')).toBe(4);
    expect(() => positiveInt('0')).toThrow(/positive integer/);
    expect(fraction('0.1')).toBe(0.1);
    expect(() => fraction('2')).toThrow(/at most 1/);
  });

  it('merges a headers file with --header entries, later wins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-hdr-'));
    const file = join(dir, 'headers.txt');
    await writeFile(file, '# auth\nAuthorization: Bearer file\nX-Tenant: acme\n');
    expect(await resolveHeaders(['x-tenant: override', 'X-Trace: 1'], file)).toEqual({
      authorization: 'Bearer file',
      'x-tenant': 'override',
      'x-trace': '1',
    });
    await expect(resolveHeaders([], join(dir, 'missing'))).rejects.toThrow(/missing/);
    await expect(resolveHeaders(['bad header'], undefined)).rejects.toThrow(/name: value/);
  });
});
