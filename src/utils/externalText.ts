/**
 * 外部由来テキスト（OSVレコードのsummary/details、OSV-Scannerのstderr等）を
 * LLMクライアントへ返す前のサニタイズ。
 *
 * プロンプトインジェクション対策の方針:
 * 「指示文の検出・除去」は原理的に完全にはできないため、
 * - 出力を構造化JSONのデータフィールドとして返す（既存設計）ことを前提に、
 * - 人間のレビュアーやLLMに「見えない」細工を無効化することに集中する。
 *
 * 除去対象:
 * - 制御文字（C0のうち\n・\t以外、DEL、C1）: ANSIエスケープによる表示偽装を含む
 * - ゼロ幅・不可視文字（ZWSP等）、BOM、ソフトハイフン: 表示に現れない文字の混入
 * - 双方向制御文字（RLO等）: 表示順の偽装
 * - Unicodeタグ文字（U+E0000〜U+E007F）: 不可視のASCII密輸（invisible prompt injection）
 * - 異体字セレクタ（U+FE00〜U+FE0F、U+E0100〜U+E01EF）: 任意のバイト列の不可視の埋め込み
 *   （variation selector smuggling）。絵文字の表示形式の指定も消える
 * - 表示されない埋め字（U+034F、U+115F、U+1160、U+3164、U+FFA0）、行間注釈（U+FFF9〜U+FFFB）
 * - 行区切りU+2028/U+2029: JSON文字列やログでの行構造の偽装
 *
 * あわせてNFC正規化で合成文字による見た目の偽装を低減する。
 * \n・\tは正当なテキスト構造（markdown等）のため保持する。
 */

// C0制御文字（\t=U+0009・\n=U+000Aを除く）、DEL、C1制御文字
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

// 不可視文字（ソフトハイフンU+00AD・モンゴル母音分離U+180E・ゼロ幅各種U+200B-200F・BOM U+FEFF）、
// 行区切り（U+2028/2029）、双方向制御（U+202A-202E・U+2066-2069）、不可視演算子等（U+2060-2064）、
// 異体字セレクタ（U+FE00-FE0F）、表示されない埋め字（U+034F・U+115F・U+1160・U+3164・U+FFA0）、
// 行間注釈（U+FFF9-FFFB）。異体字セレクタ以降は脆弱性チェックで追加（2026-11-20）
const INVISIBLE_CHARS =
  /[\u00AD\u034F\u115F\u1160\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

// Unicodeタグ文字ブロック（不可視のASCII複製。テキスト中に現れる正当な用途はない）と、
// 異体字セレクタ補助（U+E0100-E01EF。見える文字の後ろに並べて任意のバイト列を不可視に埋め込める）
const TAG_CHARS = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/**
 * 外部由来テキストから不可視・制御文字を除去する。
 * 可視文字と\n・\tはそのまま保持する（内容の書き換え・要約は行わない）。
 */
export function sanitizeExternalText(text: string): string {
  return text
    .normalize("NFC")
    .replace(TAG_CHARS, "")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "");
}
