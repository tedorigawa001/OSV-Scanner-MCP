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
 * 起動を拒否すべき設定不備があればエラーメッセージを返す。問題なければnull。
 */
export function allowedRootStartupError(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isTruthy(env[REQUIRE_ALLOWED_ROOT_ENV])) return null;
  const allowedRoot = env[ALLOWED_ROOT_ENV];
  if (allowedRoot !== undefined && allowedRoot.trim() !== "") return null;
  return (
    `${REQUIRE_ALLOWED_ROOT_ENV}が有効ですが、${ALLOWED_ROOT_ENV}が未設定のため起動を中止します。` +
    `スキャンを許可するルートディレクトリを${ALLOWED_ROOT_ENV}に設定してください`
  );
}

/**
 * 起動は許可するが注意喚起すべき設定があれば警告メッセージを返す。なければnull。
 * (許可ルート未設定=任意の絶対パスをスキャン可能な状態の可視化)
 */
export function allowedRootStartupWarning(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const allowedRoot = env[ALLOWED_ROOT_ENV];
  if (allowedRoot !== undefined && allowedRoot.trim() !== "") return null;
  return (
    `${ALLOWED_ROOT_ENV}が未設定のため、任意の絶対パスをスキャンできる状態です。` +
    `プロジェクト置き場のルートを${ALLOWED_ROOT_ENV}に設定することを推奨します` +
    `(未設定時に起動を拒否するには${REQUIRE_ALLOWED_ROOT_ENV}=1)`
  );
}
