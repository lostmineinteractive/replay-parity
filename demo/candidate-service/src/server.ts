import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const divergences = (process.env.DIVERGENCES ?? 'on').toLowerCase() !== 'off';
const seed = Number(process.env.DIVERGENCE_SEED ?? 1);
const app = buildApp({ logger: true, divergences, seed });

app.log.info({ divergences, seed }, 'candidate configuration');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host: '0.0.0.0' });
