# Writing adapters

The replay engine talks to the candidate through an adapter. The engine prepares each request, hands it to the adapter, and takes back the candidate's response with the latency the adapter measured. Two adapters ship, `http` and `bus`, and a plugin module can supply another. This page gives the contract, what the engine does before and after a send, the TLS and proxy options of the HTTP adapter, the plugin contract, and the responder a system under test runs for the bus, including consumer groups.

## The contract

```ts
export interface ReplayContext {
  id: string; // the exchange id from the recording
  index: number; // position among the selected exchanges, from 0
  tags: readonly string[];
  signal: AbortSignal; // aborted when the engine shuts down
}

export interface Adapter {
  name: string;
  send(req: RecordedRequest, ctx: ReplayContext): Promise<RecordedResponse>;
  close?(): Promise<void>;
}
```

`RecordedRequest` and `RecordedResponse` are the recording's own types from `@replay-parity/core`: method, path, query, headers, and a body that is parsed JSON, a base64 string with `encoding: "base64"`, or absent. The response carries `status`, `headers`, `latency_ms`, and a body in the same form. A body that arrived with a `content-encoding` of gzip, deflate, or br is stored decoded and carries `content_encoding` with the coding, so the differ compares what the bytes meant and not how they were compressed. An adapter measures `latency_ms` from the moment it dispatches to the moment the last byte of the body has arrived.

A transport failure is a thrown error. `toSendError` in `@replay-parity/replay` classifies any thrown value as `timeout`, `connection`, `aborted`, `protocol`, or `other`, and the engine records `kind: message` on the exchange, counts it as an error, and does not diff it.

## What the engine does around a send

Before `send`, the engine applies substitutions to the path, the query, and the body, drops every header whose recorded value is `<redacted>`, and applies caller supplied headers from `--header` and `--headers-file` over the recorded ones. The adapter receives the request as it should go out. The HTTP adapter additionally removes hop by hop headers, `host`, and `content-length`, and sets the content length from the body it sends.

After `send`, the engine records the acknowledgement time, feeds the captured values to the substitution table, diffs the response against the recorded one, and writes the request as sent and the response to the candidate recording when `--candidate-recording` is given, with the capture redaction list applied to headers.

The engine never calls `send` for an exchange before the exchanges it followed in the recording have been acknowledged, never before the producers of the values it uses have completed, and never while a barrier is waiting.

## Substitutions

A substitution rule in `diff-rules.yaml` names a value to capture and where to apply it.

```yaml
substitutions:
  - name: order_id
    capture: { tag: create-order, path: '$.order_id' }
    apply: [path, query, body]
```

When an exchange carrying the capture tag completes, the engine reads the value at `path` from the recorded reference response and from the candidate response and stores the pair. Any later request whose path segment, query value, or body leaf equals a stored reference value has it replaced with the candidate value before the send. The differ treats the pair as equivalent and reports it as tolerated by `substitution:order_id`. Whole segments and whole leaves match, so `o-1` never rewrites `o-12`. The first exchange to produce a reference value wins.

Dependencies are computed before anything is sent, from the reference responses in the recording, so a request that needs a captured value waits for its producer under every pacing mode. The demo uses this for order ids. Shipment ids and idempotency keys are client supplied and are replayed as recorded.

## The HTTP adapter

`new HttpAdapter(target, { timeoutMs, connections, maxBodyBytes })` keeps a connection pool to the target's origin and prefixes the target's path, if any, to every recorded path. The timeout is enforced by an abort signal so the deadline is exact. A response body over `maxBodyBytes` is stored as its hash and size, and the differ reports `body_too_large`. A request body stored with `content_encoding` goes out with that coding applied again, through `wireBody` from `@replay-parity/core`, so the bytes match the recorded `content-encoding` header. A response with a `content-encoding` of gzip, deflate, or br is decoded before it is stored, the cap applies to the decoded size, and the coding is noted on the response. An adapter over another transport that meets compressed bodies calls `encodeBody(bytes, contentType, maxBytes, contentEncoding)` and gets the same behavior.

### TLS and proxy

`HttpAdapterOptions` takes `tls` and `proxy`:

```ts
new HttpAdapter('https://candidate.internal:8443', {
  tls: {
    ca, // PEM text or buffers: the authorities that sign the target certificate
    cert, // PEM client certificate, for a target that asks for one
    key, // PEM private key for cert
    passphrase, // passphrase of an encrypted key
    rejectUnauthorized: true, // false accepts any certificate
    servername, // SNI name, also checked against the certificate
  },
  proxy: 'http://proxy.internal:3128',
});
```

Without `ca` the default root certificates apply, so a target with a private authority fails with a certificate error until the authority is given. `rejectUnauthorized: false` turns the check off and is meant for a throwaway environment. `servername` matters when the target is reached by an address that is not on the certificate. With a `proxy` the adapter tunnels with `CONNECT` through undici's `ProxyAgent` and applies `tls` to the connection to the target, not to the proxy. Without one it keeps a `Pool` of `connections` connections. The proxy URL is plain `http`.

On the command line, `rp replay` and `rp shrink` take the same settings as files and flags:

| Flag                           | Meaning                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `--upstream-ca <path>`         | PEM file of the authorities that sign the target certificate |
| `--upstream-cert <path>`       | PEM client certificate, used together with `--upstream-key`  |
| `--upstream-key <path>`        | PEM private key for `--upstream-cert`                        |
| `--upstream-insecure`          | Accept any certificate the target presents                   |
| `--upstream-servername <name>` | SNI name and the name the certificate is checked against     |
| `--http-proxy <url>`           | HTTP proxy to reach the target through                       |

Each is also a key under `replay:` and `shrink:` in `rp.yaml`. The preflight probe behind `--preflight-probe`, and the reset request of `rp shrink`, connect with the same settings, so a probe that passes means the replay can connect. `rp capture` takes `--upstream-ca`, `--upstream-cert`, `--upstream-key`, `--upstream-servername`, and `--upstream-insecure` for an https reference, and `--tls-cert` and `--tls-key` to listen over HTTPS. The flags apply to the built in HTTP adapter. The bus adapter and a plugin do their own connecting.

## The bus adapter

`BusAdapter` runs over a `MessageBus`:

```ts
export interface MessageBus {
  publish(topic: string, payload: string): Promise<void>;
  subscribe(
    topic: string,
    handler: (payload: string) => void | Promise<void>,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
```

`InProcessBus` delivers asynchronously in publish order inside one process. `RedisStreamsBus.connect(url)` publishes with `XADD <topic> * payload <text>` and subscribes with a blocking `XREAD` on a dedicated connection, starting at the newest entry. `rp replay --adapter bus --bus-url redis://host:6379` uses it.

For each request the adapter publishes a request envelope to the request topic and waits for the reply envelope on its own reply topic, matched by correlation id. Latency is the time from publish to reply. The default request topic is `rp.requests.<first path segment>`, so `/v1/orders/o-1` goes to `rp.requests.v1` and `/admin/restart` to `rp.requests.admin`. `BusAdapter.create(bus, { topicFor, replyTopic, timeoutMs })` changes any of that.

### The responder contract

A system under test consumes request envelopes and publishes reply envelopes.

```json
{
  "correlation_id": "01J...:7",
  "reply_to": "rp.replies.3f9a1c2b7d4e",
  "request": {
    "method": "POST",
    "path": "/v1/orders",
    "query": {},
    "headers": {},
    "body": { "sku": "A-100", "qty": 3 }
  }
}
```

```json
{
  "correlation_id": "01J...:7",
  "response": {
    "status": 201,
    "headers": { "content-type": "application/json" },
    "body": { "order_id": "o-1" }
  }
}
```

`response.headers`, `response.body`, and `response.encoding` are optional. `serveBus(bus, topic, handler)` in `@replay-parity/replay` is a reference responder: it reads envelopes from one topic, calls the handler with the `RecordedRequest`, and publishes the reply to `reply_to`. The tests run the whole engine through it.

### Consumer groups

By default `RedisStreamsBus` gives every subscriber every entry. With `RedisStreamsBus.connect(url, { group, consumer, claimIdleMs })` a subscription reads through a Redis consumer group, which is how several instances of a responder share one request topic. `rp replay` takes `--bus-group` and `--bus-consumer` for the bus it connects, which carries its reply topic.

- `subscribe` runs `XGROUP CREATE <topic> <group> $ MKSTREAM` and ignores `BUSYGROUP`, so the first subscriber creates the group and the rest join it. The group starts at the newest entry, so entries published before the group existed are not delivered.
- Entries are read with `XREADGROUP` from `>`. Each entry goes to one consumer of the group. `consumer` names this member and defaults to `rp-` and a random suffix. A consumer name without a group is an error.
- The bus sends `XACK` for an entry after the handler resolves. A handler that rejects leaves the entry pending.
- An entry that stays pending for `claimIdleMs` (default 30000) is claimed with `XAUTOCLAIM` by whichever consumer of the group checks next, and handed to its handler. A consumer that crashed, or whose handler rejected, costs a delay and not a lost request.
- Closing the bus or calling the unsubscribe function acknowledges nothing. Entries in flight stay pending and are claimed later.

Delivery is at least once. The responder's obligations follow from that:

- Publish the reply envelope before the handler resolves, since the acknowledgement follows the handler. A responder that acknowledges first and replies later loses the request when it dies in between.
- Treat a repeated `correlation_id` as a repeat of the same request. A request claimed from a slow consumer can be answered twice, and the adapter uses the first reply and ignores the rest. A responder with side effects deduplicates on the correlation id.
- Finish the handler within `claimIdleMs`, or raise `claimIdleMs` above the longest handler. An entry whose handler is still running when the interval passes is claimed and handled a second time.
- Do not rely on order across consumers. Entries of one topic are spread over the group, so a replay that needs order runs one consumer, or uses barriers.

## Adapter plugins

`--adapter-module <path>` on `rp replay` and `rp shrink` loads an ES module and uses the adapter it builds in place of the HTTP adapter. The module exports `createAdapter`:

```js
export async function createAdapter({ target, timeoutMs, connections, settings }) {
  return {
    name: 'mine',
    async send(request, context) {
      // call the system, return { status, headers, latency_ms, body? }
    },
    async close() {},
  };
}
```

- `target` is the `--target` text as given, which a plugin may read as any kind of address.
- `timeoutMs` is `--timeout-ms`, and `connections` is `--concurrency` for `rp replay`, and 1 for `rp shrink`.
- `settings` holds the repeatable `--adapter-setting key=value` pairs as strings. The text after the first `=` is the value.
- `createAdapter` returns an `Adapter` or a promise of one. The returned object needs a string `name` and a `send` function, and `close` is optional.

`loadAdapterModule(path, options)` in `@replay-parity/replay` does the loading. It resolves the path against the working directory and throws a `ConfigError`, which the CLI reports as a tool error with exit code 1, for a missing file, a module that does not load, a missing `createAdapter` export, a `createAdapter` that throws, and a result without `name` and `send`. The run records the adapter as `plugin:<name>`.

`--adapter-module` and `--adapter bus` are separate transports, and using both is an error, as is `--adapter-setting` without a module. `rp shrink` builds the adapter once and reuses it for every attempt, so a plugin that keeps state resets it itself, the way the reset URL resets the candidate. The TLS and proxy flags do not reach a plugin. Pass what it needs in `--adapter-setting`.

`examples/adapters/echo-adapter.mjs` answers from a JSON map file named in `settings.map`, and `examples/adapters/README.md` shows how to run it. The tests replay `demo/recording.jsonl` through it.

## Adding a transport

Implement `Adapter`, measure latency from dispatch to the last byte, throw on transport failure, and pass an instance to `replay({ adapter })` or `replayExchanges(exchanges, { adapter })`. The run records `adapter.name`. The engine owns pacing, ordering, substitutions, barriers, controls, the diff, the statistics, and the thresholds, so an adapter stays small.
