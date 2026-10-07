/**
 * 起動時の設定検証。
 *
 * OSV_MCP_ALLOWED_ROOT(スキャン許可ルート)は未設定でも動作するが、
 * その場合は任意の絶対パスをスキャンできてしまう。運用環境では
 * OSV_MCP_REQUIRE_ALLOWED_ROOT=1 を設定することで、許可ルート未設定時に
 * サーバーの起動自体を拒否できる(fail-closed)。
 */

export const ALLOWED_ROOT_ENV = "OSV_MCP_ALLOWED_ROOT";
export const REQUIRE_ALLOWED_ROOT_ENV = "OSV_MCP_REQUIRE_ALLOWED_ROOT";

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * 許可ルートの設定値。空文字・空白のみは未設定(undefined)として扱う。
 * 起動時の検証とツールへの受け渡しで判定がずれないよう、必ずこの関数で読む
 * (空文字をそのまま渡すと`path.resolve("")`=起動ディレクトリが許可ルートになっていた)。
 */
export function allowedRootFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const allowedRoot = env[ALLOWED_ROOT_ENV];
  return allowedRoot !== undefined && allowedRoot.trim() !== "" ? allowedRoot : undefined;
}

/**
 * 起動を拒否すべき設定不備があればエラーメッセージを返す。問題なければnull。
 */
export function allowedRootStartupError(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isTruthy(env[REQUIRE_ALLOWED_ROOT_ENV])) return null;
  if (allowedRootFromEnv(env) !== undefined) return null;
  return (
    `${REQUIRE_ALLOWED_ROOT_ENV} is enabled but ${ALLOWED_ROOT_ENV} is not set, so the server will not start. ` +
    `Set ${ALLOWED_ROOT_ENV} to the root directory that may be scanned`
  );
}

/**
 * 起動は許可するが注意喚起すべき設定があれば警告メッセージを返す。なければnull。
 * (許可ルート未設定=任意の絶対パスをスキャン可能な状態の可視化)
 */
export function allowedRootStartupWarning(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (allowedRootFromEnv(env) !== undefined) return null;
  return (
    `${ALLOWED_ROOT_ENV} is not set, so any absolute path can be scanned. ` +
    `Setting ${ALLOWED_ROOT_ENV} to the root of your projects is recommended ` +
    `(set ${REQUIRE_ALLOWED_ROOT_ENV}=1 to refuse to start when it is not set)`
  );
}
