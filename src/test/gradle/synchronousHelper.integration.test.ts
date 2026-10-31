/** Real C1a feasibility tests. The prototype is deliberately not shipped or used by MCP. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const binary = process.env.OSV_MCP_TEST_GRADLE;
const init = fileURLToPath(new URL("../fixtures/gradle-c1a-helper.init.gradle", import.meta.url));
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
type Dsl = "groovy" | "kotlin";
interface Scenario {
  inventoryComplete: boolean; complete: boolean; reasons: string[]; declaredIn: string[];
  attempts: { id: string; source: string; state: string }[];
  dependencies: number; edges: { requested: string; selected: string }[];
}
interface ProjectReport { scenarios: Record<string, Scenario>; providerRealized: boolean; configureCalls: number; trust: string; limitations: string[] }
interface Report { gradleVersion: string; projects: Record<string, ProjectReport> }

async function fixture(dsl: Dsl): Promise<Report> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-gradle-c1a-"))); dirs.push(dir);
  const suffix = dsl === "kotlin" ? ".gradle.kts" : ".gradle";
  await writeFile(path.join(dir, "settings.gradle"), "rootProject.name='c1a-probe'\ninclude 'helper', 'disabled', 'plain'\n");
  const sources: string[] = [];
  const scopes: object[] = [];
  for (const mode of ["helper", "disabled", "plain"]) {
    await mkdir(path.join(dir, mode));
    const source = `${mode}/build${suffix}`, applied = `${mode}/extra${suffix}`;
    sources.push(source, applied);
    for (const name of ["duplicates", "diamond", "mutated", "rogue", "copied", "scopeGap", "equalRogue", "reverted", "forced", "configured", "removed", "nondefault", "noAssertion"]) {
      if (name === "noAssertion") continue;
      scopes.push({ id: `${mode}-${name}`, projectPath: `:${mode}`, resolvableConfiguration: name,
        declarationConfigurations: name === "diamond" ? ["base"] : name === "scopeGap" ? [] : [name],
        assertion: "all-contributing-additions-use-helper", mutationPolicy: "immutable-after-add" });
    }
    let build = dsl === "groovy" ? `
repositories { maven { url = uri(rootProject.file('repo')) } }
configurations.create('duplicates') { canBeResolved=true; canBeConsumed=false }
def helper=extensions.getByName('osvMcpC1a')
helper.add('duplicates', 'review:sample:1', '${source}')
apply from: 'extra${suffix}'
` : `
import org.gradle.kotlin.dsl.withGroovyBuilder
repositories { maven { url = uri(rootProject.file("repo")) } }
configurations.create("duplicates") { isCanBeResolved=true; isCanBeConsumed=false }
extensions.getByName("osvMcpC1a").withGroovyBuilder {
    "add"("duplicates", "review:sample:1", "${source}")
}
apply(from = "extra${suffix}")
`;
    build += dsl === "groovy" ? `
['base','left','right','diamond','mutated','rogue','copied','scopeGap','equalRogue','reverted','forced','configured','removed','nondefault','noAssertion','unrelated'].each {
    configurations.create(it) { canBeResolved=true; canBeConsumed=false }
}
configurations.left.extendsFrom(configurations.base)
configurations.right.extendsFrom(configurations.base)
configurations.diamond.extendsFrom(configurations.left, configurations.right)
configurations.scopeGap.extendsFrom(configurations.base)
helper.add('base', 'review:sample:1', '${source}')
['mutated','rogue','copied','equalRogue','reverted','forced','noAssertion'].each { helper.add(it, 'review:sample:1', '${source}') }
configurations.mutated.dependencies.first().version { require '2' }
dependencies.add('rogue', 'review:rogue:1')
def original = configurations.copied.dependencies.first()
configurations.copied.dependencies.remove(original)
configurations.copied.dependencies.add(original.copy())
dependencies.add('equalRogue', 'review:sample:1')
configurations.reverted.dependencies.first().version { require '2' }
configurations.reverted.dependencies.first().version { require '1' }
configurations.forced.resolutionStrategy.force('review:sample:2')
helper.add('configured', 'review:sample:1', '${source}', { d -> d.version { require '1' } } as org.gradle.api.Action)
def handle=helper.add('removed', 'review:sample:1', '${source}')
if (project.name == 'plain') configurations.removed.dependencies.clear() else helper.remove(handle)
helper.add('nondefault', 'review:sample:1', '${source}', { d -> d.transitive=false } as org.gradle.api.Action)
ext.probeProviderRealized=false
configurations.unrelated.dependencies.addLater(providers.provider {
    project.ext.probeProviderRealized=true
    dependencies.create('review:sample:1')
})
` : `
val helper=extensions.getByName("osvMcpC1a")
listOf("base","left","right","diamond","mutated","rogue","copied","scopeGap","equalRogue","reverted","forced","configured","removed","nondefault","noAssertion","unrelated").forEach {
    configurations.create(it) { isCanBeResolved=true; isCanBeConsumed=false }
}
configurations["left"].extendsFrom(configurations["base"])
configurations["right"].extendsFrom(configurations["base"])
configurations["diamond"].extendsFrom(configurations["left"], configurations["right"])
configurations["scopeGap"].extendsFrom(configurations["base"])
helper.withGroovyBuilder { "add"("base", "review:sample:1", "${source}") }
listOf("mutated","rogue","copied","equalRogue","reverted","forced","noAssertion").forEach { name ->
    helper.withGroovyBuilder { "add"(name, "review:sample:1", "${source}") }
}
(configurations["mutated"].dependencies.first() as org.gradle.api.artifacts.ExternalModuleDependency).version { require("2") }
dependencies.add("rogue", "review:rogue:1")
val original=configurations["copied"].dependencies.first()
configurations["copied"].dependencies.remove(original)
configurations["copied"].dependencies.add(original.copy())
dependencies.add("equalRogue", "review:sample:1")
(configurations["reverted"].dependencies.first() as org.gradle.api.artifacts.ExternalModuleDependency).version { require("2") }
(configurations["reverted"].dependencies.first() as org.gradle.api.artifacts.ExternalModuleDependency).version { require("1") }
configurations["forced"].resolutionStrategy.force("review:sample:2")
val configure=object : org.gradle.api.Action<org.gradle.api.artifacts.ExternalModuleDependency> {
    override fun execute(d: org.gradle.api.artifacts.ExternalModuleDependency) { d.version { require("1") } }
}
helper.withGroovyBuilder { "add"("configured", "review:sample:1", "${source}", configure) }
val handle=helper.withGroovyBuilder { "add"("removed", "review:sample:1", "${source}") }
if (project.name == "plain") configurations["removed"].dependencies.clear() else helper.withGroovyBuilder { "remove"(handle) }
val nondefault=object : org.gradle.api.Action<org.gradle.api.artifacts.ExternalModuleDependency> {
    override fun execute(d: org.gradle.api.artifacts.ExternalModuleDependency) { d.isTransitive=false }
}
helper.withGroovyBuilder { "add"("nondefault", "review:sample:1", "${source}", nondefault) }
extensions.extraProperties["probeProviderRealized"]=false
configurations["unrelated"].dependencies.addLater(providers.provider {
    extensions.extraProperties["probeProviderRealized"]=true
    dependencies.create("review:sample:1")
})
`;
    const extra = dsl === "groovy"
      ? `extensions.getByName('osvMcpC1a').add('duplicates', 'review:sample:1', '${applied}')\n`
      : `import org.gradle.kotlin.dsl.withGroovyBuilder\nextensions.getByName("osvMcpC1a").withGroovyBuilder { "add"("duplicates", "review:sample:1", "${applied}") }\n`;
    await writeFile(path.join(dir, source), build); await writeFile(path.join(dir, applied), extra);
  }
  await writeFile(path.join(dir, "osv-mcp-gradle-declarations.json"), JSON.stringify({ contractVersion: 1, trustModel: "registered-helper-v1", sources, scopes }));
  for (const [name, version] of [["sample", "1"], ["sample", "2"], ["rogue", "1"]]) {
    const dest = path.join(dir, "repo/review", name!, version!); await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, `${name}-${version}.pom`), `<project><modelVersion>4.0.0</modelVersion><groupId>review</groupId><artifactId>${name}</artifactId><version>${version}</version></project>`);
  }
  const result = await new Promise<{ code: number; output: string }>(resolve => {
    execFile(binary!, ["-p", dir, "-I", init, "osvMcpProveC1a", "--offline", "--no-daemon", "--no-configuration-cache", "--console=plain", "--stacktrace"],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, env: process.env }, (error, stdout, stderr) =>
        resolve({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, output: stdout + stderr }));
  });
  expect(result.code, result.output).toBe(0);
  const json = await readFile(path.join(dir, "c1a-probe.json"), "utf8");
  const report: Report = JSON.parse(json);
  if (process.env.OSV_MCP_GRADLE_C1A_OUTPUT) await writeFile(`${process.env.OSV_MCP_GRADLE_C1A_OUTPUT}-${report.gradleVersion}-${dsl}.json`, json);
  return report;
}

for (const dsl of ["groovy", "kotlin"] as const) describe.skipIf(!binary)(`C1a synchronous helper (${dsl})`, () => {
  let report: Report;
  beforeAll(async () => { report = await fixture(dsl); }, 150_000);
  it("retains both equal addition attempts and their physical sources after Gradle collapses them", () => {
    const scenario = report.projects.helper!.scenarios.duplicates!;
    expect(scenario.complete).toBe(true);
    expect(scenario.dependencies).toBe(1);
    expect(scenario.edges).toHaveLength(1);
    expect(scenario.attempts).toHaveLength(2);
    expect(new Set(scenario.attempts.map(a => a.id)).size).toBe(2);
    expect(scenario.declaredIn).toEqual([`helper/build.gradle${dsl === "kotlin" ? ".kts" : ""}`, `helper/extra.gradle${dsl === "kotlin" ? ".kts" : ""}`]);
  });
  it("deduplicates one inherited attempt across a diamond and retains the original source", () => {
    const s=report.projects.helper!.scenarios.diamond!;
    expect(s.complete).toBe(true);
    expect(s.attempts).toHaveLength(1);
    expect(s.dependencies).toBe(1);
    expect(s.declaredIn).toEqual([`helper/build.gradle${dsl === "kotlin" ? ".kts" : ""}`]);
  });
  it.each([
    ["mutated", "declaration_mutation_detected"],
    ["rogue", "unregistered_declaration"],
    ["copied", "unregistered_declaration"],
    ["scopeGap", "scope_incomplete"],
    ["noAssertion", "declaration_assertion_missing"],
    ["removed", "declaration_identity_lost"],
    ["nondefault", "unsupported_declaration_shape"],
  ])("suppresses the entire declaration list for %s", (name, reason) => {
    const s=report.projects.helper!.scenarios[name!]!;
    expect(s.inventoryComplete).toBe(false);
    expect(s.complete).toBe(false);
    expect(s.declaredIn).toEqual([]);
    expect(s.reasons).toContain(reason);
  });
  it("binds a forced selected version to the original declaration request", () => {
    const s=report.projects.helper!.scenarios.forced!;
    expect(s.complete).toBe(true);
    expect(s.edges).toEqual([{ requested:"review:sample:1", selected:"review:sample:2" }]);
  });
  it("preserves normal graph results, configure calls and unrequested provider laziness", () => {
    for (const [name, s] of Object.entries(report.projects.plain!.scenarios)) {
      for (const mode of ["helper", "disabled"]) {
        const current=report.projects[mode]!;
        expect(current.scenarios[name]!.edges, `${mode}/${name}`).toEqual(s.edges);
        expect(current.scenarios[name]!.dependencies, `${mode}/${name}`).toBe(s.dependencies);
        expect(current.configureCalls).toBe(report.projects.plain!.configureCalls);
        expect(current.providerRealized).toBe(false);
      }
    }
    expect(report.projects.plain!.providerRealized).toBe(false);
    expect(report.projects.helper!.configureCalls).toBe(2);
  });
  it("keeps declarations suppressed when the consumer has not accepted the trust model", () => {
    expect(report.projects.disabled!.trust).toBe("disabled");
    for (const s of Object.values(report.projects.disabled!.scenarios)) {
      expect(s.complete).toBe(false);
      expect(s.declaredIn).toEqual([]);
    }
  });
  it("reports the known limits for an unregistered equal addition and a reverted mutation", () => {
    for (const name of ["equalRogue", "reverted"]) {
      expect(report.projects.helper!.scenarios[name]!.complete).toBe(true);
    }
    expect(report.projects.helper!.trust).toBe("accepted");
    expect(report.projects.helper!.limitations).toEqual([
      "unregistered_equal_additions_not_detectable", "reverted_external_mutations_not_detectable",
    ]);
  });
});
