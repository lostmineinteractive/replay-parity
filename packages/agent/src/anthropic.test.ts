import { GeneratedCaseSchema } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { AnswerSchema, decodeCase } from './answer.js';
import { AnthropicModelClient, FALLBACK_BETA, casesOutputFormat } from './anthropic.js';

interface Captured {
  url: string;
  headers: Headers;
  request: Record<string, unknown>;
}

/** Answers each path from `bodies` and records every request by path. */
function fakeFetch(bodies: Record<string, unknown>, captures: Captured[]): typeof fetch {
  return (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = new URL(url).pathname;
    captures.push({
      url,
      headers: new Headers(init?.headers),
      request: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    });
    const body = bodies[path];
    if (body === undefined) {
      return Promise.resolve(new Response('{"type":"error"}', { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'x' },
    { type: 'text', text: '{"cases": []}' },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: null,
    iterations: null,
  },
  ...over,
});

const format = casesOutputFormat();

describe('AnthropicModelClient', () => {
  it('sends the model, effort, adaptive thinking, the schema, the fallback, and max tokens, and parses text and usage', async () => {
    const captures: Captured[] = [];
    const client = new AnthropicModelClient({
      apiKey: 'test-key-not-real',
      fetch: fakeFetch({ '/v1/messages': message() }, captures),
      maxRetries: 0,
    });
    const response = await client.complete({
      system: 'sys',
      user: 'stable part. varying part.',
      cachePrefixLength: 13,
      maxTokens: 8192,
    });
    const call = captures[0]!;
    expect(call.url).toContain('/v1/messages');
    expect(call.headers.get('x-api-key')).toBe('test-key-not-real');
    expect(call.headers.get('anthropic-beta')).toBe(FALLBACK_BETA);
    expect(call.request).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format },
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'stable part. ', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'varying part.' },
          ],
        },
      ],
      fallbacks: 'default',
    });
    expect(response).toEqual({
      text: '{"cases": []}',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1200,
        output_tokens: 300,
        cache_read_tokens: 1000,
        cache_write_tokens: 0,
      },
      model: 'claude-sonnet-5-5',
      schema_constrained: true,
      fallback_ran: false,
    });
    expect(client.model).toBe('claude-sonnet-5-5');
    expect(client.fallbacks).toBe(true);
  });

  it('maps a refusal, an overridden model, and leaves the fallback out when it is off', async () => {
    const captures: Captured[] = [];
    const client = new AnthropicModelClient({
      apiKey: 'k',
      model: 'claude-opus-5-5',
      effort: 'high',
      fallbacks: false,
      fetch: fakeFetch(
        {
          '/v1/messages': message({
            content: [],
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
          }),
        },
        captures,
      ),
      maxRetries: 0,
    });
    const response = await client.complete({ system: 's', user: 'u', maxTokens: 100 });
    const call = captures[0]!;
    expect(call.request.model).toBe('claude-opus-5-5');
    expect(call.request).not.toHaveProperty('fallbacks');
    expect(call.headers.get('anthropic-beta')).toBeNull();
    // Without a prefix the user prompt is one block with no breakpoint.
    expect(call.request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'u' }] },
    ]);
    expect((call.request.output_config as { effort: string }).effort).toBe('high');
    expect(response.stop_reason).toBe('refusal');
    expect(response.refusal).toBe('cyber: declined');
    expect(response.text).toBe('');
    expect(response.fallback_ran).toBe(false);
    expect(client.fallbacks).toBe(false);
  });

  it('reports the model that answered and that a fallback ran', async () => {
    const captures: Captured[] = [];
    const client = new AnthropicModelClient({
      apiKey: 'k',
      fetch: fakeFetch(
        {
          '/v1/messages': message({
            model: 'claude-sonnet-5',
            content: [
              {
                type: 'fallback',
                from: { model: 'claude-sonnet-5-5' },
                to: { model: 'claude-sonnet-5' },
                trigger: { type: 'refusal', category: 'cyber' },
              },
              { type: 'text', text: '{"cases": []}' },
            ],
            usage: {
              input_tokens: 1200,
              output_tokens: 300,
              cache_read_input_tokens: null,
              cache_creation_input_tokens: 1200,
              iterations: [
                {
                  type: 'message',
                  model: 'claude-sonnet-5-5',
                  input_tokens: 1200,
                  output_tokens: 0,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_creation: null,
                },
                {
                  type: 'fallback_message',
                  model: 'claude-sonnet-5',
                  input_tokens: 1200,
                  output_tokens: 300,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 1200,
                  cache_creation: null,
                },
              ],
            },
          }),
        },
        captures,
      ),
      maxRetries: 0,
    });
    const response = await client.complete({ system: 's', user: 'u', maxTokens: 100 });
    expect(response.model).toBe('claude-sonnet-5');
    expect(response.fallback_ran).toBe(true);
    expect(response.stop_reason).toBe('end_turn');
    expect(response.text).toBe('{"cases": []}');
    expect(response.usage.cache_write_tokens).toBe(1200);
  });

  it('counts the tokens of the exact request through the counting endpoint', async () => {
    const captures: Captured[] = [];
    const client = new AnthropicModelClient({
      apiKey: 'k',
      fetch: fakeFetch({ '/v1/messages/count_tokens': { input_tokens: 4321 } }, captures),
      maxRetries: 0,
    });
    const request = {
      system: 'sys',
      user: 'stable. varying.',
      cachePrefixLength: 8,
      maxTokens: 10,
    };
    expect(await client.countTokens(request)).toBe(4321);
    const call = captures[0]!;
    expect(call.url).toContain('/v1/messages/count_tokens');
    expect(call.request).toEqual({
      model: 'claude-sonnet-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format },
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'stable. ', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'varying.' },
          ],
        },
      ],
    });
    expect(call.request).not.toHaveProperty('max_tokens');
  });
});

/** Every schema node under `root`, depth first. */
function* nodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item);
  } else if (value !== null && typeof value === 'object') {
    yield value as Record<string, unknown>;
    for (const item of Object.values(value)) yield* nodes(item);
  }
}

describe('casesOutputFormat', () => {
  it('is a json_schema format with the keys the cases schema has and nothing structured outputs reject', () => {
    expect(format.type).toBe('json_schema');
    const schema = format.schema;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['cases']);
    const all = [...nodes(schema)];
    for (const node of all) {
      if (node.type === 'object') expect(node.additionalProperties).toBe(false);
      for (const key of ['minimum', 'maximum', 'maxItems', 'minLength', 'maxLength', 'pattern']) {
        expect(node).not.toHaveProperty(key);
      }
      if (typeof node.minItems === 'number') expect(node.minItems).toBeLessThanOrEqual(1);
    }
    // No definition refers to itself: the JSON body travels as text, not as a recursive value.
    const defs = schema.$defs as Record<string, unknown>;
    for (const [name, def] of Object.entries(defs)) {
      for (const node of nodes(def)) expect(node.$ref).not.toBe(`#/$defs/${name}`);
    }
    const text = JSON.stringify(schema);
    for (const key of ['hypothesis', 'tags', 'steps', 'repeat', 'capture', 'body_json']) {
      expect(text).toContain(`"${key}"`);
    }
    expect(text).not.toContain('"body"');
  });

  it('describes the limits the API does not enforce so the model still sees them', () => {
    const text = JSON.stringify(format.schema);
    expect(text).toContain('maxItems: 3');
    expect(text).toContain('minimum: 1, maximum: 50');
  });

  it('accepts an answer in the constrained shape that decodes into valid cases', () => {
    const answer = {
      cases: [
        {
          hypothesis: 'a half cent total rounds differently',
          tags: ['create-order'],
          steps: [
            {
              request: {
                method: 'POST',
                path: '/v1/orders',
                headers: [{ name: 'Authorization', value: '<redacted>' }],
                body_json: '{"sku":"A-100","qty":3}',
              },
              capture: { name: 'id', path: '$.order_id' },
            },
            {
              request: {
                method: 'GET',
                path: '/v1/orders/{{id}}',
                query: [
                  { name: 'fields', value: 'total' },
                  { name: 'fields', value: 'status' },
                ],
              },
            },
          ],
          repeat: 2,
        },
      ],
    };
    expect(AnswerSchema.safeParse(answer).success).toBe(true);
    const decoded = decodeCase(answer.cases[0]);
    expect(decoded.ok).toBe(true);
    const parsed = GeneratedCaseSchema.safeParse((decoded as { value: unknown }).value);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.steps[0]?.request.body).toEqual({ sku: 'A-100', qty: 3 });
    expect(parsed.data?.steps[0]?.request.headers).toEqual({ authorization: '<redacted>' });
    expect(parsed.data?.steps[1]?.request.query).toEqual({ fields: ['total', 'status'] });
    expect(parsed.data?.repeat).toBe(2);
  });
});
