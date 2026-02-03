// Streaming support for LLM responses
// Provides unified streaming interface across providers

import type { Result } from "@agent-os/shared";
import { ok, err } from "@agent-os/shared";
import type { Logger } from "@agent-os/kernel";

/** Streaming chunk from an LLM */
export interface StreamChunk {
  /** The text content of this chunk */
  content: string;
  /** Whether this is the final chunk */
  isComplete: boolean;
  /** Cumulative content so far (optional) */
  cumulativeContent?: string;
  /** Token count for this chunk (if available) */
  tokens?: number;
  /** Model that generated this chunk */
  model?: string;
  /** Any metadata from the provider */
  metadata?: Record<string, unknown>;
}

/** Final streaming result with usage stats */
export interface StreamResult {
  /** Complete accumulated content */
  content: string;
  /** Model used */
  model: string;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Time to first chunk in ms */
  timeToFirstChunkMs: number;
  /** Total streaming duration in ms */
  totalDurationMs: number;
  /** Number of chunks received */
  chunkCount: number;
}

/** Stream handler callback */
export type StreamHandler = (chunk: StreamChunk) => void | Promise<void>;

/** Streaming options */
export interface StreamOptions {
  /** Handler called for each chunk */
  onChunk?: StreamHandler;
  /** Handler called on completion */
  onComplete?: (result: StreamResult) => void | Promise<void>;
  /** Handler called on error */
  onError?: (error: Error) => void | Promise<void>;
  /** Timeout for the entire stream in ms */
  timeoutMs?: number;
  /** Logger for debugging */
  logger?: Logger;
}

/** Stream controller for managing active streams */
export interface StreamController {
  /** Abort the stream */
  abort(): void;
  /** Check if stream is active */
  isActive(): boolean;
  /** Get current accumulated content */
  getContent(): string;
  /** Wait for stream completion */
  wait(): Promise<Result<StreamResult>>;
}

/** Create a stream controller from an async iterator */
export function createStreamController(
  iterator: AsyncIterableIterator<StreamChunk>,
  options: StreamOptions = {}
): StreamController {
  const {
    onChunk,
    onComplete,
    onError,
    timeoutMs = 300000, // 5 minutes default
    logger,
  } = options;

  let aborted = false;
  let active = true;
  let content = "";
  let chunkCount = 0;
  const startTime = Date.now();
  let firstChunkTime: number | null = null;

  // Using a wrapper object to hold the resolve function
  // This avoids TypeScript narrowing issues with the closure
  const resolver: { resolve: (result: Result<StreamResult>) => void } = {
    resolve: () => {},
  };
  const completionPromise = new Promise<Result<StreamResult>>((resolve) => {
    resolver.resolve = resolve;
  });

  // Process the stream
  (async () => {
    const timeoutId = setTimeout(() => {
      if (active) {
        aborted = true;
        active = false;
        const error = new Error(`Stream timeout after ${timeoutMs}ms`);
        logger?.error("Stream timeout", { timeoutMs, contentLength: content.length });
        if (onError) {
          Promise.resolve(onError(error)).catch(() => {});
        }
        resolver.resolve(err(error));
      }
    }, timeoutMs);

    try {
      for await (const chunk of iterator) {
        if (aborted) {
          logger?.debug("Stream aborted by user");
          break;
        }

        if (firstChunkTime === null) {
          firstChunkTime = Date.now();
          logger?.debug("First stream chunk received", {
            timeToFirstChunkMs: firstChunkTime - startTime,
          });
        }

        content += chunk.content;
        chunkCount++;

        if (onChunk) {
          await onChunk({
            ...chunk,
            cumulativeContent: content,
          });
        }

        if (chunk.isComplete) {
          break;
        }
      }

      clearTimeout(timeoutId);
      active = false;

      if (!aborted) {
        const result: StreamResult = {
          content,
          model: "",
          usage: {
            inputTokens: 0,
            outputTokens: estimateTokens(content),
          },
          timeToFirstChunkMs: firstChunkTime ? firstChunkTime - startTime : 0,
          totalDurationMs: Date.now() - startTime,
          chunkCount,
        };

        logger?.debug("Stream completed", {
          contentLength: content.length,
          chunkCount,
          totalDurationMs: result.totalDurationMs,
        });

        if (onComplete) {
          await onComplete(result);
        }

        resolver.resolve(ok(result));
      }
    } catch (error) {
      clearTimeout(timeoutId);
      active = false;

      const wrappedError =
        error instanceof Error ? error : new Error(String(error));

      logger?.error("Stream error", {
        error: wrappedError.message,
        contentLength: content.length,
        chunkCount,
      });

      if (onError) {
        await onError(wrappedError);
      }

      resolver.resolve(err(wrappedError));
    }
  })();

  return {
    abort(): void {
      if (active) {
        aborted = true;
        active = false;
        logger?.debug("Stream abort requested");
      }
    },

    isActive(): boolean {
      return active;
    },

    getContent(): string {
      return content;
    },

    wait(): Promise<Result<StreamResult>> {
      return completionPromise;
    },
  };
}

/** Estimate token count from text (rough approximation) */
export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English
  // This is a heuristic; actual tokenization varies by model
  return Math.ceil(text.length / 4);
}

/** Create an async generator from provider-specific stream */
export async function* transformProviderStream<T>(
  stream: AsyncIterable<T>,
  transformer: (chunk: T) => StreamChunk | null
): AsyncGenerator<StreamChunk> {
  for await (const chunk of stream) {
    const transformed = transformer(chunk);
    if (transformed) {
      yield transformed;
    }
  }
}

/** Buffer stream chunks for batch processing */
export function createChunkBuffer(
  flushIntervalMs: number = 100,
  onFlush: (chunks: StreamChunk[]) => void | Promise<void>
): {
  add: (chunk: StreamChunk) => void;
  flush: () => Promise<void>;
  stop: () => void;
} {
  let buffer: StreamChunk[] = [];
  let intervalId: NodeJS.Timeout | null = null;

  const flush = async () => {
    if (buffer.length > 0) {
      const toFlush = buffer;
      buffer = [];
      await onFlush(toFlush);
    }
  };

  intervalId = setInterval(() => {
    flush().catch(() => {});
  }, flushIntervalMs);

  return {
    add(chunk: StreamChunk): void {
      buffer.push(chunk);
    },

    async flush(): Promise<void> {
      await flush();
    },

    stop(): void {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
}

/** Create a throttled stream that limits chunk frequency */
export async function* throttleStream(
  stream: AsyncIterable<StreamChunk>,
  minIntervalMs: number = 50
): AsyncGenerator<StreamChunk> {
  let lastYieldTime = 0;
  let bufferedContent = "";

  for await (const chunk of stream) {
    const now = Date.now();
    const elapsed = now - lastYieldTime;

    if (elapsed >= minIntervalMs) {
      // Yield buffered content plus new chunk
      const combinedContent = bufferedContent + chunk.content;
      bufferedContent = "";
      lastYieldTime = now;

      yield {
        ...chunk,
        content: combinedContent,
      };
    } else {
      // Buffer this chunk
      bufferedContent += chunk.content;

      // Always yield the final chunk
      if (chunk.isComplete) {
        yield {
          ...chunk,
          content: bufferedContent,
        };
      }
    }
  }

  // Yield any remaining buffered content
  if (bufferedContent.length > 0) {
    yield {
      content: bufferedContent,
      isComplete: true,
    };
  }
}

/** Collect all chunks into a single result */
export async function collectStream(
  stream: AsyncIterable<StreamChunk>,
  logger?: Logger
): Promise<Result<StreamResult>> {
  let content = "";
  let chunkCount = 0;
  let model = "";
  const startTime = Date.now();
  let firstChunkTime: number | null = null;

  try {
    for await (const chunk of stream) {
      if (firstChunkTime === null) {
        firstChunkTime = Date.now();
      }

      content += chunk.content;
      chunkCount++;

      if (chunk.model) {
        model = chunk.model;
      }

      if (chunk.isComplete) {
        break;
      }
    }

    const result: StreamResult = {
      content,
      model,
      usage: {
        inputTokens: 0,
        outputTokens: estimateTokens(content),
      },
      timeToFirstChunkMs: firstChunkTime ? firstChunkTime - startTime : 0,
      totalDurationMs: Date.now() - startTime,
      chunkCount,
    };

    logger?.debug("Stream collected", {
      contentLength: content.length,
      chunkCount,
      totalDurationMs: result.totalDurationMs,
    });

    return ok(result);
  } catch (error) {
    const wrappedError =
      error instanceof Error ? error : new Error(String(error));

    logger?.error("Stream collection error", {
      error: wrappedError.message,
      contentLength: content.length,
      chunkCount,
    });

    return err(wrappedError);
  }
}

/** Convert non-streaming response to a stream */
export async function* responseToStream(
  content: string,
  model: string,
  chunkSize: number = 100
): AsyncGenerator<StreamChunk> {
  for (let i = 0; i < content.length; i += chunkSize) {
    const chunk = content.slice(i, i + chunkSize);
    const isComplete = i + chunkSize >= content.length;

    yield {
      content: chunk,
      isComplete,
      model,
    };

    // Small delay to simulate streaming
    if (!isComplete) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
