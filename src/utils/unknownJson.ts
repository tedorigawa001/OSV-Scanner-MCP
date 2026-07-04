/**
 * 外部由来JSONを型安全に読むための防御的アクセサ。
 * 形式が想定と異なっても例外を投げず、読み取れない値はnull/空として扱う。
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asStrings(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === "string");
}
