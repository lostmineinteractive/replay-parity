/**
 * The model contract. Plain text in, plain text out, with usage. The real
 * client wraps the Anthropic SDK and the mock replays scripted answers.
 */
export interface ModelRequest {
  system: string;
  user: string;
  /**
   * Characters at the start of `user` that are the same from call to call
   * within one loop. A client with prompt caching puts a cache breakpoint
   * there. Zero or absent means no breakpoint inside the user prompt.
   */
  cachePrefixLength?: number | undefined;
  maxTokens: number;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type ModelStopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'other';

export interface ModelResponse {
  text: string;
  stop_reason: ModelStopReason;
  usage: ModelUsage;
  /** What the API reported it ran, when known. After a fallback this is the model that answered. */
  model?: string | undefined;
  /** A short explanation when the model refused. */
  refusal?: string | undefined;
  /** True when the API constrained the answer to the cases schema. */
  schema_constrained?: boolean | undefined;
  /** True when the requested model declined and a fallback model produced the answer. */
  fallback_ran?: boolean | undefined;
}

export interface ModelClient {
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  /**
   * The input tokens the request would be billed for, counted by the
   * provider. Absent on a client without a counting endpoint, in which case
   * the loop estimates from the character count.
   */
  countTokens?(request: ModelRequest): Promise<number>;
}

export const ZERO_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

export type MockAnswer =
  | string
  | { text: string; stop_reason?: ModelStopReason; usage?: Partial<ModelUsage> }
  | ((request: ModelRequest, call: number) => ModelResponse | string);

export interface MockCall {
  request: ModelRequest;
  response: ModelResponse;
}

export interface MockModelClientOptions {
  model?: string | undefined;
  usage?: Partial<ModelUsage> | undefined;
  /** When given, the mock counts tokens with it. Without it the mock has no counter. */
  countTokens?: ((request: ModelRequest) => number | Promise<number>) | undefined;
}

/** Answers from a script, one per call. The last answer repeats when the script runs out. */
export class MockModelClient implements ModelClient {
  readonly model: string;
  readonly calls: MockCall[] = [];
  countTokens?: (request: ModelRequest) => Promise<number>;
  private readonly answers: MockAnswer[];
  private readonly usage: ModelUsage;

  constructor(answers: MockAnswer[], options: MockModelClientOptions = {}) {
    if (answers.length === 0) throw new Error('the mock needs at least one answer');
    this.answers = answers;
    this.model = options.model ?? 'mock-model';
    this.usage = { ...ZERO_USAGE, input_tokens: 1000, output_tokens: 200, ...options.usage };
    const counter = options.countTokens;
    if (counter !== undefined) {
      this.countTokens = async (request) => counter(request);
    }
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    const index = Math.min(this.calls.length, this.answers.length - 1);
    const answer = this.answers[index] as MockAnswer;
    let response: ModelResponse;
    if (typeof answer === 'function') {
      const produced = answer(request, this.calls.length + 1);
      response =
        typeof produced === 'string'
          ? { text: produced, stop_reason: 'end_turn', usage: { ...this.usage } }
          : produced;
    } else if (typeof answer === 'string') {
      response = { text: answer, stop_reason: 'end_turn', usage: { ...this.usage } };
    } else {
      response = {
        text: answer.text,
        stop_reason: answer.stop_reason ?? 'end_turn',
        usage: { ...this.usage, ...answer.usage },
      };
    }
    this.calls.push({ request, response });
    return Promise.resolve(response);
  }
}
