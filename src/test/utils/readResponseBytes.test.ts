import { describe, expect, it } from "vitest";
import { readResponseBytes } from "../../utils/readResponseBytes.js";

describe("readResponseBytes", () => {
  it("rejects oversized headers without reading and cancels the body", async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { reads++; },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const error = new Error("size limit");
    await expect(readResponseBytes(new Response(body, {
      headers: { "content-length": "9" },
    }), 8, error)).rejects.toBe(error);
    expect(reads).toBe(0);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it.each(["invalid", "-1", "0"])("counts actual bytes with header %s", async (length) => {
    const error = new Error("size limit");
    await expect(readResponseBytes(new Response("123456789", {
      headers: { "content-length": length },
    }), 8, error)).rejects.toBe(error);
  });

  it("accepts empty and exact-limit responses", async () => {
    expect(await readResponseBytes(new Response(null), 0, new Error())).toEqual(Buffer.alloc(0));
    const response = new Response("12345678");
    expect(await readResponseBytes(response, 8, new Error())).toEqual(Buffer.from("12345678"));
    expect(response.body!.locked).toBe(false);
  });

  it.each(["reject", "pending"])("preserves size error when cancellation is %s", async (mode) => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(9)); },
      cancel() {
        return mode === "reject" ? Promise.reject(new Error("cancel failed")) : new Promise(() => {});
      },
    }, { highWaterMark: 0 });
    const error = new Error("size limit");
    await expect(readResponseBytes(new Response(body), 8, error)).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });

  it("releases the reader on a body error", async () => {
    const error = new Error("connection reset");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(error); },
    });
    await expect(readResponseBytes(new Response(body), 8, new Error())).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });
});
