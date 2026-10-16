import { buildApp } from './app.js';
import { DivergenceError, parseDivergences } from './divergences.js';

const port = Number(process.env.PORT ?? 3000);
const seed = Number(process.env.DIVERGENCE_SEED ?? 1);
const storePath = process.env.STORE_PATH ?? null;

let divergences;
try {
  divergences = parseDivergences(process.env.DIVERGENCES);
} catch (err) {
  if (err instanceof DivergenceError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const app = buildApp({ logger: true, divergences, seed, storePath });
app.log.info({ divergences: [...divergences], seed, storePath }, 'candidate configuration');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host: '0.0.0.0' });
