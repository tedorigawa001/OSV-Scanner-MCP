/**
 * pom.xmlの親POM(`<parent><relativePath>`)の参照の解釈。連鎖のコピーと検証はscanSnapshot.tsが行う。
 *
 * osv-scanner v2.4.0の実機確認(2026-10-07):
 * - `<relativePath>`の指す親POMを読み、その依存を結果に含める(`--no-resolve`でも同じ)。親の親もたどる
 * - `<relativePath>`省略時はMavenの既定値`../pom.xml`を参照する。ディレクトリを指す場合はその中のpom.xml
 * - `<relativePath/>`(空)はローカルを参照しない。親のGAVが一致しない場合も読まない
 *
 * スナップショット方式では、osv-scannerが読めるのはコピーしたファイルだけのため、ここでの解釈が
 * osv-scannerとずれても範囲外は読まれない(最悪でも親が見つからない)。解釈できない場合の除外は、
 * 親から引き継ぐ依存を黙って欠落させないためのもの。
 */

const DEFAULT_RELATIVE_PATH = "../pom.xml";

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

/** XMLの文字参照・定義済み実体参照を展開する。未知の実体はundefined */
function decodeEntities(text: string): string | undefined {
  let unknown = false;
  const decoded = text.replace(/&([^;\s&]*);?/g, (match, body: string) => {
    if (!match.endsWith(";")) unknown = true;
    else if (/^#x[0-9a-fA-F]+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(2), 16));
    else if (/^#[0-9]+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(1), 10));
    else if (body in NAMED_ENTITIES) return NAMED_ENTITIES[body]!;
    else unknown = true;
    return match;
  });
  return unknown ? undefined : decoded;
}

/**
 * 親POMのrelativePath。null=親なし / ""=ローカルを参照しない / undefined=解釈できない(除外する)
 *
 * osv-scannerのXMLデコーダー(Go)の挙動に合わせる(2026-10-07 実機確認):
 * - 要素は名前空間・接頭辞に関係なくローカル名で照合する(`<m:parent>`も親として読む)。大文字小文字は区別する
 * - ルート要素の直下の`parent`だけが対象(入れ子の`parent`は無視される)。複数あると後のものが有効になる
 * - 実体参照・CDATAは展開され、relativePathの前後の空白は除かれる
 * 正規表現で「最初の<parent>」を探すと、おとりの入れ子・重複・接頭辞で迂回されるため、先頭から順に読む。
 * 判断を誤ると範囲外を読ませるので、複数のparent/relativePath、CDATA、DOCTYPE、閉じていないタグなど、
 * Goと同じ解釈を保証できない構文は解釈できない(undefined)として扱う。
 */
export function parentRelativePath(source: string): string | null | undefined {
  // XML 1.0の行末処理: 解析前にCRLF・単独のCRをLFへ正規化する(Goのデコーダーも同じ)。
  // 正規化しないと、検査側は"a\rb"を探して存在しないと判断し、osv-scannerは"a\nb"を読む
  const xml = source.replace(/\r\n?/g, "\n");
  const stack: string[] = [];
  let parents = 0;
  let relativePaths = 0;
  let relativeText: string | null = null;
  let capturing = false;
  let pos = 0;

  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    const textEnd = lt === -1 ? xml.length : lt;
    if (capturing) relativeText += xml.slice(pos, textEnd);
    if (lt === -1) break;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) return undefined;
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) return undefined; // CDATA・DOCTYPE・ENTITY宣言
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) return undefined;
      pos = end + 2;
      continue;
    }
    // タグの終わりを探す(属性値の引用符内の'>'は除く)
    let i = lt + 1;
    let quote: string | null = null;
    for (; i < xml.length; i++) {
      const c = xml[i];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (i >= xml.length) return undefined;
    const raw = xml.slice(lt + 1, i);
    pos = i + 1;

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (stack.pop() !== name) return undefined; // 対応しない終了タグ
      if (capturing && stack.length === 2) capturing = false; // relativePathの終了
      continue;
    }
    const qname = /^[^\s/]+/.exec(raw)?.[0];
    if (qname === undefined) return undefined;
    const local = qname.slice(qname.lastIndexOf(":") + 1);
    const selfClosing = raw.endsWith("/");
    const depth = stack.length; // 0=ルート
    if (capturing) return undefined; // relativePathの中に要素がある
    if (depth === 1 && local === "parent") parents++;
    if (depth === 2 && local === "relativePath" && stack[1]!.slice(stack[1]!.lastIndexOf(":") + 1) === "parent") {
      relativePaths++;
      relativeText = "";
      capturing = !selfClosing;
    }
    if (!selfClosing) stack.push(qname);
  }

  if (stack.length !== 0 || capturing) return undefined; // 閉じていないタグ
  if (parents === 0) return null;
  if (parents > 1 || relativePaths > 1) return undefined;
  if (relativePaths === 0) return DEFAULT_RELATIVE_PATH;
  const decoded = decodeEntities(relativeText!);
  // プロパティ参照(${...})は評価できない
  if (decoded === undefined || decoded.includes("${")) return undefined;
  const trimmed = decoded.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  // 制御文字・通常の空白以外の空白・書式文字は、文字の正規化や前後の空白の除去の細部
  // (JSとGoで扱いが異なる)で参照先がずれうるため、解釈できないものとして除外する
  if (/[\p{Cc}\p{Cf}\u0085]|(?! )\p{Z}/u.test(trimmed)) return undefined;
  return trimmed;
}

/** UTF-8として厳密に読む。不正なバイト列・NULを含む場合はnull(Goと同じ解釈を保証できない) */
export function decodePomBytes(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes("\u0000") ? null : text;
}
