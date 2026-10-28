import { parse } from "smol-toml";
import { createParseBudget } from "./dependencyRelations.js";
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Bound TOML containers and structural work before asking the parser to allocate them. */
export function parseBoundedToml(source: string): Record<string, unknown> | null {
  try {
    if (Buffer.byteLength(source) > 16 * 1024 * 1024) return null;
    // Structural work is bounded per file in proportion to its size, as for the other lockfile parsers.
    const maxStructure = createParseBudget(source).remaining;
    let quote = "", triple = false, escaped = false, comment = false, depth = 0, structure = 0, dots = 0;
    for (let i = 0; i < source.length; i++) {
      const c = source[i]!;
      if (comment) { if (c === "\n") { comment = false; dots = 0; } continue; }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (quote === '"' && c === "\\") { escaped = true; continue; }
        if (c === quote && (!triple || source.slice(i, i + 3) === quote.repeat(3))) {
          if (triple) i += 2;
          quote = ""; triple = false;
        }
        continue;
      }
      if (c === "#") { comment = true; continue; }
      if (c === '"' || c === "'") { quote = c; triple = source.slice(i, i + 3) === c.repeat(3); if (triple) i += 2; continue; }
      if (c === "\n") dots = 0;
      if (c === "." && ++dots > 128) return null;
      if (c === "[" || c === "{") { if (++depth > 128) return null; }
      else if (c === "]" || c === "}") { if (--depth < 0) return null; }
      if ("[]{}=,.".includes(c) && ++structure > maxStructure) return null;
    }
    if (depth || quote) return null;
    const value = parse(source, { unsafeKeyBehaviour: "throw" });
    if (!record(value)) return null;
    return value;
  } catch { return null; }
}
