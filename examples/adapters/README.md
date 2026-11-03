# Adapter plugins

An adapter plugin is an ES module that exports `createAdapter`. `rp replay` and `rp shrink` load it with `--adapter-module <path>` and use the adapter it returns in place of the HTTP adapter. The contract is in [docs/writing-adapters.md](../../docs/writing-adapters.md).

## echo-adapter.mjs

Answers from a JSON file instead of calling a service. It shows the shape of a plugin and is handy for trying a rules file without a candidate.

The file maps `"<METHOD> <path>"` to a response, or to a list of responses served in order with the last one repeating:

```json
{
  "GET /v1/items": { "status": 200, "body": { "items": [1, 2, 3] } },
  "POST /v1/orders": [
    { "status": 201, "body": { "order_id": "o-1" } },
    { "status": 201, "body": { "order_id": "o-2" } }
  ]
}
```

Run it:

```sh
rp replay --recording recording.jsonl --target echo://map \
  --adapter-module examples/adapters/echo-adapter.mjs \
  --adapter-setting map=responses.json
```

The run records the adapter as `plugin:echo`. A request with no entry in the file is answered with a 404 and a body that names the key.

## Writing your own

Export `createAdapter({ target, timeoutMs, connections, settings })`. It returns an object with a `name` and a `send(request, context)` method, or a promise of one. `close()` is optional and runs once when the replay ends. `settings` holds the `--adapter-setting key=value` pairs as strings.
