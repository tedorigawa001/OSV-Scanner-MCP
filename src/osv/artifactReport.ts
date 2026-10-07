import { ScanToolError } from "../errors.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { asArray, asRecord } from "../utils/unknownJson.js";
import { parseOsvScanOutput } from "./scanReport.js";

const WARNING = "Best-effort metadata identification only. Missing or removed metadata can hide dependencies, even in identified archives. Zero identified vulnerabilities does not establish safety.";
const HINT = "Metadata may be missing (shaded/minimized archive). Scan the build project's lockfile instead.";
const INFERRED_WARNING =
  "Some Maven coordinates were inferred from file names because the JAR has no pom.properties (inferred_coordinates). " +
  "Inferred groupIds are often wrong (e.g. spring-beans:spring-beans instead of org.springframework:spring-beans), " +
  "so known vulnerabilities of these packages may be missed. Scan the build project's lockfile or pom.xml (scan_project) for accurate results.";
const INFERRED_HINT = "Identified only by inferred coordinates (no pom.properties). Known vulnerabilities may be missed.";
/** coverage.inferred_coordinatesの上限(巨大なWARで応答を膨らませない) */
const MAX_INFERRED_ITEMS = 200;

/**
 * osv-scannerがpom.propertiesのないJARについて、ファイル名等から推測した座標か(B3の実物の検証で判明)。
 * 推測の座標はgroupIdを誤りやすく(`spring-beans:spring-beans`、`jar:grpc-netty-shaded`、`all:opentelemetry-api`)、
 * OSVで照会しても0件になり既知の脆弱性を取りこぼす。osv-scannerの出力には座標の出所がないため、
 * groupIdに`.`がないものを推測とみなす。`commons-io:commons-io`のような古い形式の正しい座標も含む(安全側)。
 * `.`を含む誤った推測(`com.sun.jna:jna`)は区別できない
 */
export function isInferredCoordinate(name: string): boolean {
  const groupId = name.split(":")[0] ?? "";
  return !groupId.includes(".");
}

function isIdentifiedPackage(raw: unknown): boolean {
  const info = asRecord(asRecord(raw)?.package);
  if (info?.ecosystem !== "Maven" || typeof info.name !== "string" || typeof info.version !== "string") return false;
  const parts = info.name.split(":");
  return parts.length === 2 && parts.every((part) => part.trim() !== "" && part.toLowerCase() !== "unknown") &&
    info.version.trim() !== "" && info.version.toLowerCase() !== "unknown";
}

export function buildArtifactReport(raw: unknown, artifactPaths: readonly string[]) {
  const results = asRecord(raw)?.results;
  if (!Array.isArray(results)) {
    throw new ScanToolError("invalid_output", "OSV-Scanner artifact output is missing its results array");
  }
  const byPath = new Map<string, unknown[]>();
  for (const result of results) {
    const record = asRecord(result);
    const source = asRecord(record?.source);
    // Identity comparison must precede display sanitization, which can collapse distinct names.
    const sourcePath = source?.path;
    if (source?.type !== "artifact" || typeof sourcePath !== "string" || !artifactPaths.includes(sourcePath)) continue;
    const packages = asArray(record?.packages).filter(isIdentifiedPackage);
    if (packages.length > 0) byPath.set(sourcePath, [...(byPath.get(sourcePath) ?? []), ...packages]);
  }
  const normalized = [...byPath].map(([file, packages]) => ({ source: { path: file }, packages }));
  const report = parseOsvScanOutput({ results: normalized });
  const coordinateOf = (raw: unknown) => {
    const info = asRecord(asRecord(raw)?.package)!;
    return { name: String(info.name), version: String(info.version) };
  };
  const artifacts = artifactPaths.map((file) => {
    const packages = byPath.get(file);
    const perFile = parseOsvScanOutput({ results: [{ packages: packages ?? [] }] });
    // 推測の座標だけで同定したアーカイブは「同定済み・既知の脆弱性なし」と誤読させないよう別の状態にする
    const inferredOnly = packages !== undefined && packages.every((raw) => isInferredCoordinate(coordinateOf(raw).name));
    return {
      path: sanitizeExternalText(file),
      status: packages === undefined ? "unidentified" : perFile.vulnerability_count > 0
        ? "identified_with_vulnerabilities" : inferredOnly ? "inferred_only" : "identified_without_known_vulnerabilities",
      identified_vulnerability_count: perFile.vulnerability_count,
    };
  });
  // 推測の座標の一覧(既知の脆弱性のないものも含む。名前と版で重複を除く)
  const inferred = [...new Map([...byPath.values()].flat().map(coordinateOf)
    .filter((c) => isInferredCoordinate(c.name)).map((c) => [`${c.name}@${c.version}`, c])).values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    coverage: {
      jars_found: artifactPaths.length,
      jars_identified: artifacts.filter((item) => item.status !== "unidentified" && item.status !== "inferred_only").length,
      unidentified_jars: artifacts.filter((item) => item.status === "unidentified" || item.status === "inferred_only")
        .map(({ path, status }) => ({ path, hint: status === "inferred_only" ? INFERRED_HINT : HINT })),
      completeness: "incomplete" as const,
      warning: WARNING,
      ...(inferred.length > 0 ? {
        inferred_coordinates: {
          count: inferred.length,
          items: inferred.slice(0, MAX_INFERRED_ITEMS).map((c) => ({ name: sanitizeExternalText(c.name), version: sanitizeExternalText(c.version) })),
          ...(inferred.length > MAX_INFERRED_ITEMS ? { omitted: inferred.length - MAX_INFERRED_ITEMS } : {}),
          warning: INFERRED_WARNING,
        },
      } : {}),
    },
    artifacts,
    identified_vulnerability_count: report.vulnerability_count,
    identified_vulnerable_package_count: report.vulnerable_package_count,
    severity_breakdown: report.severity_breakdown,
    packages: report.packages.map((pkg) => {
      if (!isInferredCoordinate(pkg.name)) return pkg;
      const { vulnerabilities, ...rest } = pkg;
      return { ...rest, coordinates_inferred: true as const, vulnerabilities };
    }),
  };
}
