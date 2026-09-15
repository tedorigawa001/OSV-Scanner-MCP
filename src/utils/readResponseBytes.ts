/** Read a fetch body without retaining more than the configured byte limit. */
export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  sizeError: Error,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    // Cleanup must not delay or replace the size-limit error.
    void response.body?.cancel().catch(() => {});
    throw sizeError;
  }
  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - total) throw sizeError;
      total += value.byteLength;
      if (value.byteLength > 0) chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
