import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStreamController,
  estimateTokens,
  collectStream,
  responseToStream,
  createChunkBuffer,
  throttleStream,
  type StreamChunk,
  type StreamResult,
} from "../streaming.js";
import { ok, err } from "@agent-os/shared";

describe("Streaming Module", () => {
  describe("estimateTokens", () => {
    it("should estimate tokens from text", () => {
      const text = "Hello, world!"; // 13 chars
      const tokens = estimateTokens(text);
      expect(tokens).toBe(4); // ceil(13/4) = 4
    });

    it("should return 0 for empty text", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("should handle long text", () => {
      const text = "a".repeat(1000);
      const tokens = estimateTokens(text);
      expect(tokens).toBe(250); // ceil(1000/4)
    });
  });

  describe("createStreamController", () => {
    async function* mockStream(
      chunks: string[],
      delayMs: number = 0
    ): AsyncGenerator<StreamChunk> {
      for (let i = 0; i < chunks.length; i++) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        yield {
          content: chunks[i]!,
          isComplete: i === chunks.length - 1,
        };
      }
    }

    it("should create a stream controller", () => {
      const controller = createStreamController(mockStream(["hello"]));

      expect(controller).toHaveProperty("abort");
      expect(controller).toHaveProperty("isActive");
      expect(controller).toHaveProperty("getContent");
      expect(controller).toHaveProperty("wait");
    });

    it("should accumulate content", async () => {
      const controller = createStreamController(
        mockStream(["Hello", " ", "World"])
      );

      const result = await controller.wait();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe("Hello World");
      }
    });

    it("should call onChunk callback", async () => {
      const onChunk = vi.fn();

      const controller = createStreamController(
        mockStream(["Hello", " ", "World"]),
        { onChunk }
      );

      await controller.wait();

      expect(onChunk).toHaveBeenCalledTimes(3);
      expect(onChunk).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Hello" })
      );
    });

    it("should call onComplete callback", async () => {
      const onComplete = vi.fn();

      const controller = createStreamController(mockStream(["Hello"]), {
        onComplete,
      });

      await controller.wait();

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Hello",
          chunkCount: 1,
        })
      );
    });

    it("should track timing stats", async () => {
      const controller = createStreamController(
        mockStream(["Hello", "World"])
      );

      const result = await controller.wait();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.timeToFirstChunkMs).toBeGreaterThanOrEqual(0);
        expect(result.value.totalDurationMs).toBeGreaterThanOrEqual(0);
        expect(result.value.chunkCount).toBe(2);
      }
    });

    it("should report active status", async () => {
      const controller = createStreamController(mockStream(["Hello"]));

      // Initially active (briefly)
      const waitPromise = controller.wait();

      await waitPromise;

      expect(controller.isActive()).toBe(false);
    });

    it("should allow content retrieval during streaming", async () => {
      async function* slowStream(): AsyncGenerator<StreamChunk> {
        yield { content: "Hello", isComplete: false };
        yield { content: " World", isComplete: true };
      }

      const controller = createStreamController(slowStream());

      await controller.wait();

      expect(controller.getContent()).toBe("Hello World");
    });
  });

  describe("collectStream", () => {
    async function* mockStream(chunks: string[]): AsyncGenerator<StreamChunk> {
      for (let i = 0; i < chunks.length; i++) {
        yield {
          content: chunks[i]!,
          isComplete: i === chunks.length - 1,
          model: i === chunks.length - 1 ? "test-model" : undefined,
        };
      }
    }

    it("should collect all chunks into result", async () => {
      const result = await collectStream(mockStream(["Hello", " ", "World"]));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe("Hello World");
        expect(result.value.chunkCount).toBe(3);
      }
    });

    it("should capture model from chunks", async () => {
      const result = await collectStream(mockStream(["Hello"]));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.model).toBe("test-model");
      }
    });

    it("should handle errors", async () => {
      async function* errorStream(): AsyncGenerator<StreamChunk> {
        yield { content: "Hello", isComplete: false };
        throw new Error("Stream error");
      }

      const result = await collectStream(errorStream());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Stream error");
      }
    });
  });

  describe("responseToStream", () => {
    it("should convert response to stream", async () => {
      const chunks: StreamChunk[] = [];

      for await (const chunk of responseToStream("Hello World", "test-model", 5)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((c) => c.content).join("")).toBe("Hello World");
    });

    it("should mark last chunk as complete", async () => {
      const chunks: StreamChunk[] = [];

      for await (const chunk of responseToStream("Hi", "test-model")) {
        chunks.push(chunk);
      }

      const lastChunk = chunks.at(-1);
      expect(lastChunk).toBeDefined();
      if (!lastChunk) return;
      expect(lastChunk.isComplete).toBe(true);
    });

    it("should include model in chunks", async () => {
      for await (const chunk of responseToStream("Hi", "my-model")) {
        expect(chunk.model).toBe("my-model");
      }
    });
  });

  describe("createChunkBuffer", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should buffer chunks", async () => {
      const onFlush = vi.fn();
      const buffer = createChunkBuffer(100, onFlush);

      buffer.add({ content: "Hello", isComplete: false });
      buffer.add({ content: " World", isComplete: false });

      expect(onFlush).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(onFlush).toHaveBeenCalledWith([
        { content: "Hello", isComplete: false },
        { content: " World", isComplete: false },
      ]);

      buffer.stop();
    });

    it("should allow manual flush", async () => {
      const onFlush = vi.fn();
      const buffer = createChunkBuffer(1000, onFlush);

      buffer.add({ content: "Hello", isComplete: false });
      await buffer.flush();

      expect(onFlush).toHaveBeenCalledWith([
        { content: "Hello", isComplete: false },
      ]);

      buffer.stop();
    });

    it("should not flush empty buffer", async () => {
      const onFlush = vi.fn();
      const buffer = createChunkBuffer(100, onFlush);

      await vi.advanceTimersByTimeAsync(100);

      expect(onFlush).not.toHaveBeenCalled();

      buffer.stop();
    });
  });

  describe("throttleStream", () => {
    async function* fastStream(): AsyncGenerator<StreamChunk> {
      for (let i = 0; i < 5; i++) {
        yield { content: `${i}`, isComplete: i === 4 };
      }
    }

    it("should yield chunks", async () => {
      const chunks: StreamChunk[] = [];

      for await (const chunk of throttleStream(fastStream(), 0)) {
        chunks.push(chunk);
      }

      const content = chunks.map((c) => c.content).join("");
      expect(content).toBe("01234");
    });

    it("should preserve final chunk completeness", async () => {
      const chunks: StreamChunk[] = [];

      for await (const chunk of throttleStream(fastStream(), 0)) {
        chunks.push(chunk);
      }

      const lastChunk = chunks.at(-1);
      expect(lastChunk).toBeDefined();
      if (!lastChunk) return;
      expect(lastChunk.isComplete).toBe(true);
    });
  });
});

describe("StreamChunk type", () => {
  it("should have correct structure", () => {
    const chunk: StreamChunk = {
      content: "Hello",
      isComplete: false,
    };

    expect(chunk.content).toBe("Hello");
    expect(chunk.isComplete).toBe(false);
  });

  it("should support optional fields", () => {
    const chunk: StreamChunk = {
      content: "Hello",
      isComplete: true,
      cumulativeContent: "Hello World",
      tokens: 5,
      model: "test-model",
      metadata: { foo: "bar" },
    };

    expect(chunk.cumulativeContent).toBe("Hello World");
    expect(chunk.tokens).toBe(5);
    expect(chunk.model).toBe("test-model");
    expect(chunk.metadata).toEqual({ foo: "bar" });
  });
});

describe("StreamResult type", () => {
  it("should have correct structure", () => {
    const result: StreamResult = {
      content: "Hello World",
      model: "test-model",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
      timeToFirstChunkMs: 100,
      totalDurationMs: 500,
      chunkCount: 3,
    };

    expect(result.content).toBe("Hello World");
    expect(result.model).toBe("test-model");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.timeToFirstChunkMs).toBe(100);
    expect(result.totalDurationMs).toBe(500);
    expect(result.chunkCount).toBe(3);
  });
});
