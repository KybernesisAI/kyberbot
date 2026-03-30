declare module '@anthropic-ai/claude-code' {
  interface QueryOptions {
    prompt: string;
    options?: {
      cwd?: string;
      maxTurns?: number;
      model?: string;
      customSystemPrompt?: string;
      permissionMode?: string;
    };
  }

  interface QueryMessage {
    type: string;
    message?: {
      content?: unknown;
    };
  }

  function query(options: QueryOptions): AsyncIterable<QueryMessage>;
}
