/** Public API feasibility only: never enables production catalog adoption. */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const binary = process.env.OSV_MCP_TEST_GRADLE;
const init = fileURLToPath(new URL("../fixtures/gradle-catalog-registration.init.gradle", import.meta.url));
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
interface Scenario {
  failed: boolean; failure: string | null; graph: string[];
  additions: { id: string; source: string; callbacks: number; members: { name: string; version: string; strict: string | null; matched: boolean }[] }[];
}
interface ProjectReport { catalogs: { name: string; libraries: string[]; bundles: string[] }[]; trace: string[]; producerCalls: Record<string, number>; conversionCalls: number; scenarios: Record<string, Scenario>; }
interface Report { gradleVersion: string; projects: Record<string, ProjectReport>; inputs: { publicationAllowed: boolean; changed: string[]; baseline: Record<string, string>; final: Record<string, string> }; }
async function fixture(kotlin: boolean, mutation: "none" | "evaluation" | "task" = "none"): Promise<Report> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-catalog-proof-"))); dirs.push(dir);
  await mkdir(path.join(dir, "gradle"));
  await mkdir(path.join(dir, "catalog"));
  await writeFile(path.join(dir, "settings.gradle"), `rootProject.name='catalog-proof'
include 'plain','control','registered'
dependencyResolutionManagement { versionCatalogs { create('tools') {
  from(files('catalog/company.versions.toml'))
  version('client','2')
} } }
`);
  await writeFile(path.join(dir, "catalog-published.json"), "previous\n");
  const toml = `
[versions]
client = "1"
[libraries]
client = { module = "review:alpha", version.ref = "client" }
client-tools = { module = "review:beta", version = "1" }
same = { module = "review:alpha", version = "1" }
rich = { module = "review:beta", version = { strictly = "1" } }
[bundles]
pair = ["client", "client-tools", "same"]
pair-extra = ["client"]
empty = []
`;
  await writeFile(path.join(dir, "gradle/libs.versions.toml"), toml);
  await writeFile(path.join(dir, "catalog/company.versions.toml"), toml);
  for (const mode of ["plain", "control", "registered"]) {
    await mkdir(path.join(dir, mode));
    const cases = ["alias", "nativeAlias", "generatedConvertible", "countedConvertible", "bundle", "generatedBundleConvertible", "countedBundleConvertible", "countedBundle", "duplicateBundle", "bundleAction", "bundleFailure", "override", "rich", "empty", "unused"];
    const build = kotlin ? `
import org.gradle.kotlin.dsl.withGroovyBuilder
import org.gradle.api.artifacts.VersionCatalogsExtension
repositories { maven { url=uri(rootProject.file("repo")) } }
val probe=extensions.getByName("osvCatalogProbe")
val catalogs=extensions.getByType<VersionCatalogsExtension>()
${cases.map(name => `configurations.create("${name}") { isCanBeResolved=true; isCanBeConsumed=false }`).join("\n")}
probe.withGroovyBuilder { "add"("alias",libs.client.asProvider().map { probe.withGroovyBuilder { "produced"("alias") }; it },"build.gradle.kts","library","client") }
probe.withGroovyBuilder { "add"("nativeAlias",catalogs.named("libs").findLibrary("client").get(),"build.gradle.kts","library","client") }
probe.withGroovyBuilder { "add"("generatedConvertible",libs.client,"build.gradle.kts","library","client") }
val counted=probe.withGroovyBuilder { "convertible"(libs.client.asProvider().map { probe.withGroovyBuilder { "produced"("countedConvertible") }; it }) }
probe.withGroovyBuilder { "add"("countedConvertible",counted,"build.gradle.kts","library","client") }
probe.withGroovyBuilder { "add"("bundle",libs.bundles.pair.asProvider(),"build.gradle.kts","bundle","pair") }
probe.withGroovyBuilder { "add"("generatedBundleConvertible",libs.bundles.pair,"build.gradle.kts","bundle","pair") }
val countedBundle=probe.withGroovyBuilder { "convertible"(libs.bundles.pair.asProvider()) }
probe.withGroovyBuilder { "add"("countedBundleConvertible",countedBundle,"build.gradle.kts","bundle","pair") }
probe.withGroovyBuilder { "add"("countedBundle",libs.bundles.pair.asProvider().map { probe.withGroovyBuilder { "produced"("countedBundle") }; it },"build.gradle.kts","bundle","pair") }
probe.withGroovyBuilder { "add"("duplicateBundle",libs.bundles.pair.asProvider(),"build.gradle.kts","bundle","pair") }
${["bundleAction", "bundleFailure"].map(name=>`${name==="bundleFailure"?"try {":""}probe.withGroovyBuilder { "add"("${name}",libs.bundles.pair.asProvider(),"build.gradle.kts","bundle","pair",org.gradle.api.Action<org.gradle.api.artifacts.ExternalModuleDependency> { val dep=this; probe.withGroovyBuilder { "configure"("${name}",dep) } }) }${name==="bundleFailure"?' } catch(error: Exception) { probe.withGroovyBuilder { "caught"("bundleFailure",error) } }':""}`).join("\n")}
probe.withGroovyBuilder { "add"("override",catalogs.named("tools").findLibrary("client").get(),"build.gradle.kts","library","client",null,"tools") }
probe.withGroovyBuilder { "add"("rich",libs.rich,"build.gradle.kts","library","rich") }
probe.withGroovyBuilder { "add"("empty",libs.bundles.empty,"build.gradle.kts","bundle","empty") }
probe.withGroovyBuilder { "add"("unused",libs.bundles.pair.asProvider().map { probe.withGroovyBuilder { "produced"("unused") }; it },"build.gradle.kts","bundle","pair") }
apply(from="extra.gradle.kts")
probe.withGroovyBuilder { "mark"("configured") }
` : `
repositories { maven { url=uri(rootProject.file('repo')) } }
def probe=extensions.getByName('osvCatalogProbe')
def catalogs=extensions.getByType(org.gradle.api.artifacts.VersionCatalogsExtension)
${cases.map(name => `configurations.create('${name}') { canBeResolved=true; canBeConsumed=false }`).join("\n")}
probe.add('alias',libs.client.asProvider().map { probe.produced('alias'); it },'build.gradle','library','client')
probe.add('nativeAlias',catalogs.named('libs').findLibrary('client').get(),'build.gradle','library','client')
probe.add('generatedConvertible',libs.client,'build.gradle','library','client')
probe.add('countedConvertible',probe.convertible(libs.client.asProvider().map { probe.produced('countedConvertible'); it }),'build.gradle','library','client')
probe.add('bundle',libs.bundles.pair.asProvider(),'build.gradle','bundle','pair')
probe.add('generatedBundleConvertible',libs.bundles.pair,'build.gradle','bundle','pair')
probe.add('countedBundleConvertible',probe.convertible(libs.bundles.pair.asProvider()),'build.gradle','bundle','pair')
probe.add('countedBundle',libs.bundles.pair.asProvider().map { probe.produced('countedBundle'); it },'build.gradle','bundle','pair')
probe.add('duplicateBundle',libs.bundles.pair.asProvider(),'build.gradle','bundle','pair')
${["bundleAction", "bundleFailure"].map(name=>`${name==="bundleFailure"?"try {":""}probe.add('${name}',libs.bundles.pair.asProvider(),'build.gradle','bundle','pair',{dep -> probe.configure('${name}',dep)} as org.gradle.api.Action)${name==="bundleFailure"?" } catch(Exception error) { probe.caught('bundleFailure',error) }":""}`).join("\n")}
probe.add('override',catalogs.named('tools').findLibrary('client').get(),'build.gradle','library','client',null,'tools')
probe.add('rich',libs.rich,'build.gradle','library','rich')
probe.add('empty',libs.bundles.empty,'build.gradle','bundle','empty')
probe.add('unused',libs.bundles.pair.asProvider().map { probe.produced('unused'); it },'build.gradle','bundle','pair')
apply from: 'extra.gradle'
probe.mark('configured')
`;
    const extra = kotlin ? `
import org.gradle.kotlin.dsl.withGroovyBuilder
import org.gradle.api.artifacts.VersionCatalogsExtension
val probe=extensions.getByName("osvCatalogProbe")
val catalog=extensions.getByType<VersionCatalogsExtension>().named("libs")
probe.withGroovyBuilder { "add"("duplicateBundle",catalog.findBundle("pair").get(),"extra.gradle.kts","bundle","pair") }
` : `
def probe=extensions.getByName('osvCatalogProbe')
def catalog=extensions.getByType(org.gradle.api.artifacts.VersionCatalogsExtension).named('libs')
probe.add('duplicateBundle',catalog.findBundle('pair').get(),'extra.gradle','bundle','pair')
`;
    await writeFile(path.join(dir, mode, kotlin ? "extra.gradle.kts" : "extra.gradle"), extra);
    const change = kotlin ? `
rootProject.file("gradle/libs.versions.toml").appendText("\\n# changed\\n")
rootProject.file("catalog/company.versions.toml").appendText("\\n# changed\\n")
rootProject.file("settings.gradle").appendText("\\n// changed\\n")
rootProject.file("catalog/generated.versions.toml").writeText("# generated")
` : `
rootProject.file('gradle/libs.versions.toml').append('\\n# changed\\n')
rootProject.file('catalog/company.versions.toml').append('\\n# changed\\n')
rootProject.file('settings.gradle').append('\\n// changed\\n')
rootProject.file('catalog/generated.versions.toml').text='# generated'
`;
    const mutationCode = mode !== "registered" || mutation === "none" ? "" : mutation === "evaluation" ? change : kotlin ? `
gradle.projectsEvaluated {
  val mutate=tasks.register("mutateCatalogInputs") { doLast { ${change} } }
  rootProject.tasks.named("osvProveCatalogRegistration") { dependsOn(mutate) }
}
` : `
gradle.projectsEvaluated {
  def mutate=tasks.register('mutateCatalogInputs') { doLast { ${change} } }
  rootProject.tasks.named('osvProveCatalogRegistration') { dependsOn(mutate) }
}
`;
    await writeFile(path.join(dir, mode, kotlin ? "build.gradle.kts" : "build.gradle"), build + mutationCode);
  }
  for (const name of ["alpha", "beta"]) for (const version of ["1", "2"]) {
    const dest = path.join(dir, "repo/review", name, version); await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, `${name}-${version}.pom`), `<project><modelVersion>4.0.0</modelVersion><groupId>review</groupId><artifactId>${name}</artifactId><version>${version}</version></project>`);
  }
  const result = await new Promise<{ code: number; output: string }>(resolve => execFile(binary!, ["-p", dir, "-I", init, "osvProveCatalogRegistration", "--offline", "--no-daemon", "--no-configuration-cache", "--console=plain", "--stacktrace"],
    { env: process.env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }, (e, out, err) => resolve({ code: e ? typeof e.code === "number" ? e.code : -1 : 0, output: out + err })));
  expect(result.code, result.output).toBe(0);
  const json = await readFile(path.join(dir, "catalog-proof.json"), "utf8"); const report: Report = JSON.parse(json);
  if (process.env.OSV_MCP_GRADLE_CATALOG_OUTPUT) await writeFile(`${process.env.OSV_MCP_GRADLE_CATALOG_OUTPUT}-${report.gradleVersion}-${kotlin ? "kotlin" : "groovy"}-${mutation}.json`, json);
  expect(await readFile(path.join(dir, "catalog-published.json"), "utf8")).toBe(mutation === "none" ? "verified\n" : "previous\n");
  return report;
}
for (const kotlin of [false, true]) describe.skipIf(!binary)(`Catalog registration (Kotlin=${kotlin})`, () => {
  let report: Report;
  beforeAll(async () => { report = await fixture(kotlin); }, 150_000);
  it("preserves native alias materialization phases and counts", () => {
    const { plain, control, registered } = report.projects;
    expect(registered!.trace).toEqual(plain!.trace);
    expect(control!.trace).toEqual(plain!.trace);
    expect(registered!.producerCalls).toEqual(plain!.producerCalls);
    expect(registered!.conversionCalls).toEqual(plain!.conversionCalls);
    // Absolute counts keep the equality checks above from passing when nothing is evaluated at all.
    expect(registered!.producerCalls).toEqual({ alias: 1, countedConvertible: 1, countedBundle: 1 });
    expect(registered!.conversionCalls).toBe(2);
    expect(registered!.scenarios.alias!.graph).toEqual(plain!.scenarios.alias!.graph);
    expect(registered!.scenarios.alias!.additions[0]!.members).toMatchObject([{ name: "review:alpha", version: "1", matched: true }]);
    expect(report.inputs.changed).toEqual([]);
  });
  for (const name of ["nativeAlias", "generatedConvertible", "countedConvertible", "bundle", "generatedBundleConvertible", "countedBundleConvertible", "duplicateBundle", "bundleAction", "override", "rich", "empty", "countedBundle", "bundleFailure"]) {
    it(`preserves native outcome and materialization evidence for ${name}`, () => {
      const plain=report.projects.plain!.scenarios[name]!, control=report.projects.control!.scenarios[name]!, r=report.projects.registered!.scenarios[name]!;
      expect(r.graph).toEqual(plain.graph); expect(control.graph).toEqual(plain.graph);
      expect(r.failed).toBe(plain.failed); expect(r.failure).toBe(plain.failure);
      if (["countedBundle", "bundleFailure"].includes(name)) expect(r.failed).toBe(true);
      else expect(r.failed).toBe(false);
      if (["bundle", "generatedBundleConvertible", "countedBundleConvertible", "bundleAction"].includes(name)) {
        expect(r.additions[0]!.callbacks).toBe(3);
        expect(r.additions[0]!.members.every(m=>m.matched)).toBe(true);
      }
      if (name==="bundleAction") expect(r.additions[0]!.members.every(m=>m.version==="2")).toBe(true);
      if (name==="duplicateBundle") {
        expect(r.additions).toHaveLength(2);
        expect(new Set(r.additions.map(a=>a.id)).size).toBe(2);
        expect(r.additions.map(a=>a.source)).toEqual([kotlin?"build.gradle.kts":"build.gradle",kotlin?"extra.gradle.kts":"extra.gradle"]);
        expect(r.additions.every(a=>a.callbacks===3 && a.members.every(m=>m.matched))).toBe(true);
      }
      if (name==="override") {
        expect(r.additions[0]!.members[0]!.version).toBe("2");
        expect(r.graph).toEqual(["review:alpha:2"]);
      }
      if (name==="rich") expect(r.additions[0]!.members).toMatchObject([{ name: "review:beta", strict: "1", matched: true }]);
      if (name==="empty") expect(r.additions[0]!.callbacks).toBe(0);
    });
  }
  it("does not evaluate an unused mapped bundle or invent its members", () => {
    for(const p of Object.values(report.projects)) expect(p.producerCalls.unused).toBeUndefined();
    expect(report.projects.registered!.scenarios.unused!.additions[0]!.members).toEqual([]);
  });
  it("retains both public catalog inventories without deriving input origins from them", () => {
    expect(report.projects.registered!.catalogs.map(c=>c.name)).toEqual(["libs","tools"]);
    expect(report.inputs.publicationAllowed).toBe(true);
  });
  for(const mutation of ["evaluation","task"] as const) it(`rejects stale catalog/settings and newly generated input during ${mutation}`, async () => {
    const r=await fixture(kotlin,mutation);
    expect(r.inputs.changed.sort()).toEqual(["catalog/company.versions.toml","catalog/generated.versions.toml","gradle/libs.versions.toml","settings.gradle"]);
    expect(r.inputs.publicationAllowed).toBe(false);
    expect(r.inputs.baseline["catalog/generated.versions.toml"]).toBe("absent");
  },150_000);

});
