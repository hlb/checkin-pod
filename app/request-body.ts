export type LimitedTextResult =
  | { ok: true; value: string }
  | { ok: false; reason: "invalid" | "too_large" };

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

/** Read the actual request stream and enforce a byte limit even without Content-Length. */
export async function readLimitedText(request: Request, maximumBytes: number): Promise<LimitedTextResult> {
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredBytes = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      return { ok: false, reason: "invalid" };
    }
    if (declaredBytes > maximumBytes) return { ok: false, reason: "too_large" };
  }

  if (!request.body) return { ok: true, value: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let value = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
