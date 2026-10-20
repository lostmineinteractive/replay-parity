# Writing adapters

The replay engine talks to the candidate through an adapter. The engine prepares each request, hands it to the adapter, and takes back the candidate's response with the latency the adapter measured. Two adapters ship: `http` and `bus`. This page gives the contract, what the engine does before and after a send, and the responder a system under test runs for the bus.

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

## Adding a transport

Implement `Adapter`, measure latency from dispatch to the last byte, throw on transport failure, and pass an instance to `replay({ adapter })` or `replayExchanges(exchanges, { adapter })`. The run records `adapter.name`. The engine owns pacing, ordering, substitutions, barriers, controls, the diff, the statistics, and the thresholds, so an adapter stays small.
