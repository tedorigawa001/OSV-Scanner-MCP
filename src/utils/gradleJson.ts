import { visit } from "jsonc-parser";
/** Shared bounded JSON parsing for graph and author contracts. */
export function parseGradleJson(text: string, maxBytes = 16 * 1024 * 1024): unknown {
  if (Buffer.byteLength(text) > maxBytes) throw new Error("graph_size_limit");
  const stack: (Set<string> | null)[] = [];
  const enter = (object: boolean) => { if (stack.length >= 128) throw new Error("graph_depth_limit"); stack.push(object ? new Set() : null); };
  visit(text, { onObjectBegin: () => enter(true), onArrayBegin: () => enter(false),
    onObjectProperty: key => { const keys = stack.at(-1); if (keys?.has(key)) throw new Error("duplicate_json_key"); keys?.add(key); },
    onObjectEnd: () => { stack.pop(); }, onArrayEnd: () => { stack.pop(); }, onError: () => { throw new Error("invalid_json"); },
  }, { disallowComments: true, allowTrailingComma: false });
  return JSON.parse(text);
}
