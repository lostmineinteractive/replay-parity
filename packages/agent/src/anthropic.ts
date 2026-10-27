import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnswerSchema } from './answer.js';
import type { ModelClient, ModelRequest, ModelResponse, ModelStopReason } from './client.js';

/**
 * The real client. One call per round through the beta Messages API with
 * adaptive thinking, a fixed effort, the answer constrained to the cases
 * schema through `output_config.format`, and the server side refusal
 * fallback. The API key comes from the caller, never from a log line.
 *
 * Prompt caching: the system prompt and the stable prefix of the user prompt
 * each carry a cache breakpoint, so every round after the first reads the run
 * summary and the request shapes from the cache instead of paying for them
 * again. The usage the API reports says how many tokens were read or written.
 *
 * Fallbacks: with `fallbacks` on, the request carries the beta header and
 * `fallbacks: "default"`, so a round the requested model declines is retried
 * inside the same call on the model Anthropic routes that refusal category
 * to. The response names the model that answered, and a `fallback_message`
 * entry in the usage iterations says a fallback ran. A refusal on the final
 * response means the whole chain declined. The feature is Claude API only.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT = 'medium';
export const DEFAULT_MAX_TOKENS = 8192;
/** The beta header the `"default"` form of `fallbacks` requires. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicClientOptions {
  apiKey: string;
  model?: string | undefined;
  effort?: Effort | undefined;
  /** Retry a declined round on a fallback model inside the same call. Default true. */
  fallbacks?: boolean | undefined;
  /** Replaces the HTTP transport. Tests pass a function that answers without a network. */
  fetch?: typeof fetch | undefined;
  /** Request timeout in milliseconds. Default 120000. */
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}

/**
 * The JSON Schema the answer is constrained to: the answer schema through
 * zod's `toJSONSchema`, reduced by the SDK helper to what structured outputs
 * accept. A constraint the API does not take, such as the step limit or the
 * repeat range, moves into a description and `validateCases` enforces it
 * after the call.
 */
export function casesOutputFormat(): Anthropic.Beta.BetaJSONOutputFormat {
  return { type: 'json_schema', schema: zodOutputFormat(AnswerSchema).schema };
}

function mapStop(reason: string | null): ModelStopReason {
  if (reason === 'end_turn' || reason === 'max_tokens' || reason === 'refusal') return reason;
  return 'other';
}

function userContent(request: ModelRequest): Anthropic.Beta.BetaTextBlockParam[] {
  const prefix = request.cachePrefixLength ?? 0;
  return prefix > 0 && prefix < request.user.length
    ? [
        {
          type: 'text',
          text: request.user.slice(0, prefix),
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: request.user.slice(prefix) },
      ]
    : [{ type: 'text', text: request.user }];
}

export class AnthropicModelClient implements ModelClient {
  readonly model: string;
  readonly fallbacks: boolean;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly format: Anthropic.Beta.BetaJSONOutputFormat;

  constructor(options: AnthropicClientOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    this.fallbacks = options.fallbacks ?? true;
    this.format = casesOutputFormat();
    this.client = new Anthropic({
      apiKey: options.apiKey,
      timeout: options.timeoutMs ?? 120_000,
      maxRetries: options.maxRetries ?? 2,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /** Everything a call and its token count share. */
  private shape(request: ModelRequest): Anthropic.Beta.MessageCountTokensParams {
    return {
      model: this.model,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort, format: this.format },
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent(request) }],
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      ...this.shape(request),
      max_tokens: request.maxTokens,
    };
    if (this.fallbacks) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    const message = await this.client.beta.messages.create(params);
    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const iterations = message.usage.iterations ?? [];
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
      schema_constrained: true,
      fallback_ran: iterations.some((entry) => entry.type === 'fallback_message'),
    };
    if (message.stop_reason === 'refusal') {
      const details = message.stop_details;
      response.refusal = details
        ? `${details.category ?? 'unspecified'}: ${details.explanation ?? ''}`.trim()
        : 'the model declined to answer';
    }
    return response;
  }

  /** Counts the input tokens of the exact request, system prompt and schema included. */
  async countTokens(request: ModelRequest): Promise<number> {
    const result = await this.client.beta.messages.countTokens(this.shape(request));
    return result.input_tokens;
  }
}
