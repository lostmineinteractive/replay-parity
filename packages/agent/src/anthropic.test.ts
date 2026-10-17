import { describe, expect, it } from 'vitest';
import { AnthropicModelClient } from './anthropic.js';

function fakeFetch(
  body: unknown,
  capture: { request?: unknown; headers?: Headers; url?: string },
): typeof fetch {
  return (input, init) => {
    capture.url = String(input instanceof Request ? input.url : input);
    capture.headers = new Headers(init?.headers);
    capture.request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
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
  },
  ...over,
});

describe('AnthropicModelClient', () => {
  it('sends the model, effort, adaptive thinking, and max tokens, and parses text and usage', async () => {
    const capture: { request?: unknown; headers?: Headers; url?: string } = {};
    const client = new AnthropicModelClient({
      apiKey: 'test-key-not-real',
      fetch: fakeFetch(message(), capture),
      maxRetries: 0,
    });
    const response = await client.complete({ system: 'sys', user: 'ask', maxTokens: 8192 });
    expect(capture.url).toContain('/v1/messages');
    expect(capture.headers?.get('x-api-key')).toBe('test-key-not-real');
    expect(capture.request).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: 'sys',
      messages: [{ role: 'user', content: 'ask' }],
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
    });
    expect(client.model).toBe('claude-sonnet-5-5');
  });

  it('maps a refusal and an overridden model', async () => {
    const capture: { request?: unknown } = {};
    const client = new AnthropicModelClient({
      apiKey: 'k',
      model: 'claude-opus-5-5',
      effort: 'high',
      fetch: fakeFetch(
        message({
          content: [],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
        }),
        capture,
      ),
      maxRetries: 0,
    });
    const response = await client.complete({ system: 's', user: 'u', maxTokens: 100 });
    expect((capture.request as { model: string; output_config: { effort: string } }).model).toBe(
      'claude-opus-5-5',
    );
    expect((capture.request as { output_config: { effort: string } }).output_config.effort).toBe(
      'high',
    );
    expect(response.stop_reason).toBe('refusal');
    expect(response.refusal).toBe('cyber: declined');
    expect(response.text).toBe('');
  });
});
