import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJsonSchema } from '../src/run/io.js';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../schema/run.schema.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(runJsonSchema(), null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${out}\n`);
