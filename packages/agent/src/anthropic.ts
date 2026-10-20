import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest, ModelResponse, ModelStopReason } from './client.js';

/**
 * The real client. One `messages.create` per call with adaptive thinking and
 * a fixed effort. The API key comes from the caller, never from a log line.
 *
 * Prompt caching: the system prompt and the stable prefix of the user prompt
 * each carry a cache breakpoint, so every round after the first reads the run
 * summary and the request shapes from the cache instead of paying for them
 * again. The usage the API reports says how many tokens were read or written.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT = 'medium';
export const DEFAULT_MAX_TOKENS = 8192;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicClientOptions {
  apiKey: string;
  model?: string | undefined;
  effort?: Effort | undefined;
  /** Replaces the HTTP transport. Tests pass a function that answers without a network. */
  fetch?: typeof fetch | undefined;
  /** Request timeout in milliseconds. Default 120000. */
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}

function mapStop(reason: string | null): ModelStopReason {
  if (reason === 'end_turn' || reason === 'max_tokens' || reason === 'refusal') return reason;
  return 'other';
}

export class AnthropicModelClient implements ModelClient {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;

  constructor(options: AnthropicClientOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      timeout: options.timeoutMs ?? 120_000,
      maxRetries: options.maxRetries ?? 2,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const prefix = request.cachePrefixLength ?? 0;
    const content: Anthropic.TextBlockParam[] =
      prefix > 0 && prefix < request.user.length
        ? [
            {
              type: 'text',
              text: request.user.slice(0, prefix),
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: request.user.slice(prefix) },
          ]
        : [{ type: 'text', text: request.user }];
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const response: ModelResponse = {
      text,
      stop_reason: mapStop(message.stop_reason),
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_read_tokens: message.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      model: message.model,
    };
    if (message.stop_reason === 'refusal') {
      const details = message.stop_details;
      response.refusal = details
        ? `${details.category ?? 'unspecified'}: ${details.explanation ?? ''}`.trim()
        : 'the model declined to answer';
    }
    return response;
  }
}
