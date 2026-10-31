/** Opt-in real Gradle C1b API experiment. No production adapter is enabled. */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const binary=process.env.OSV_MCP_TEST_GRADLE;
const init=fileURLToPath(new URL("../fixtures/gradle-provider-registration.init.gradle",import.meta.url));
const dirs:string[]=[];
afterAll(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
interface Scenario {
  graph: { requested: string; selected: string }[]; failed: boolean; failure: string | null;
  registrations: { id: string; callbacks: number; status: string; matched: boolean }[];
}
interface ProjectReport { callerValue: string; trace: string[]; producerCalls: Record<string,number>; configureCalls: Record<string,number>; scenarios: Record<string,Scenario>; }
interface Report { gradleVersion: string; projects: Record<string,ProjectReport>; }
async function fixture(kotlin:boolean):Promise<Report> {
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),"osv-provider-registration-")));dirs.push(dir);
  await writeFile(path.join(dir,"settings.gradle"),"rootProject.name='provider-probe'\ninclude 'plain','control','registered'\n");
  for(const mode of ["plain","control","registered"]) {
    await mkdir(path.join(dir,mode));
    const cases=["stable","object","action","duplicate","changing","absent","throws","actionThrows","unused"];
    const build=kotlin ? `
import org.gradle.kotlin.dsl.withGroovyBuilder
import org.gradle.api.Action
import org.gradle.api.artifacts.ExternalModuleDependency
repositories { maven { url=uri(rootProject.file("repo")) } }
val probe=extensions.getByName("osvProviderProbe")
${cases.map(name=>`
configurations.create("${name}") { isCanBeResolved=true; isCanBeConsumed=false }
val ${name}Provider=providers.provider { probe.withGroovyBuilder { "produce"("${name}","${name}") } }
probe.withGroovyBuilder { "add"("${name}",${name}Provider,"build.gradle.kts"${name.startsWith("action")?', Action<ExternalModuleDependency> { val dependency=this; probe.withGroovyBuilder { "configure"("'+name+'",dependency) } }':""}) }
${name==="duplicate"?'probe.withGroovyBuilder { "add"("duplicate",duplicateProvider,"build.gradle.kts") }':""}
`).join("")}
val property=objects.property(String::class.java)
property.set(providers.provider { probe.withGroovyBuilder { "produce"("property","stable") } as String })
configurations.create("property") { isCanBeResolved=true; isCanBeConsumed=false }
probe.withGroovyBuilder { "add"("property",property,"build.gradle.kts") }
probe.withGroovyBuilder { "inherited"(providers.provider { probe.withGroovyBuilder { "produce"("inherited","stable") } },"build.gradle.kts") }
probe.withGroovyBuilder { "mark"("configured") }
` : `
repositories { maven { url=uri(rootProject.file('repo')) } }
def probe=extensions.getByName('osvProviderProbe')
${cases.map(name=>`
configurations.create('${name}') { canBeResolved=true; canBeConsumed=false }
def ${name}Provider=providers.provider { probe.produce('${name}','${name}') }
probe.add('${name}',${name}Provider,'build.gradle'${name.startsWith("action")?", { dep -> probe.configure('"+name+"',dep) } as org.gradle.api.Action":""})
${name==="duplicate"?"probe.add('duplicate',duplicateProvider,'build.gradle')":""}
`).join("")}
def property=objects.property(String)
property.set(providers.provider { probe.produce('property','stable') })
configurations.create('property') { canBeResolved=true; canBeConsumed=false }
probe.add('property',property,'build.gradle')
probe.inherited(providers.provider { probe.produce('inherited','stable') },'build.gradle')
probe.mark('configured')
`;
    await writeFile(path.join(dir,mode,kotlin?"build.gradle.kts":"build.gradle"),build);
  }
  for(const version of ["1","2"]) {
    const dest=path.join(dir,"repo/review/sample",version);await mkdir(dest,{recursive:true});
    await writeFile(path.join(dest,`sample-${version}.pom`),`<project><modelVersion>4.0.0</modelVersion><groupId>review</groupId><artifactId>sample</artifactId><version>${version}</version></project>`);
  }
  const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,["-p",dir,"-I",init,"osvProveProviderRegistration","--offline","--no-daemon","--no-configuration-cache","--console=plain","--stacktrace"],
    {env:process.env,timeout:120_000,maxBuffer:2*1024*1024},(e,out,err)=>resolve({code:e?typeof e.code==="number"?e.code:-1:0,output:out+err})));
  expect(result.code,result.output).toBe(0);
  const json=await readFile(path.join(dir,"provider-registration.json"),"utf8");const report:Report=JSON.parse(json);
  if(process.env.OSV_MCP_GRADLE_PROVIDER_OUTPUT) await writeFile(`${process.env.OSV_MCP_GRADLE_PROVIDER_OUTPUT}-${report.gradleVersion}-${kotlin?"kotlin":"groovy"}.json`,json);
  return report;
}
for(const kotlin of [false,true]) describe.skipIf(!binary)(`Provider registration (Kotlin=${kotlin})`,()=>{
  let report:Report;
  beforeAll(async()=>{report=await fixture(kotlin);},150_000);
  it("records materialization without changing supplier evaluation timing or count",()=>{
    const plain=report.projects.plain!,control=report.projects.control!,registered=report.projects.registered!;
    expect(registered.trace).toEqual(plain.trace);
    expect(control.trace).toEqual(plain.trace);
    expect(registered.producerCalls).toEqual(plain.producerCalls);
    expect(control.producerCalls).toEqual(plain.producerCalls);
    expect(control.configureCalls).toEqual(plain.configureCalls);
    expect(registered.configureCalls).toEqual(plain.configureCalls);
    expect(registered.scenarios.stable!.graph).toEqual(plain.scenarios.stable!.graph);
    expect(registered.scenarios.stable!.registrations).toEqual([{id:"d0",callbacks:1,status:"materialized",matched:true}]);
  });
  for (const name of ["object","action","duplicate","changing","absent","throws","actionThrows","property"]) {
    it(`preserves native result and observations for ${name}`,()=>{
      const plain=report.projects.plain!,registered=report.projects.registered!,control=report.projects.control!;
      expect(control.scenarios[name]!.graph).toEqual(plain.scenarios[name]!.graph);
      expect(control.scenarios[name]!.failure).toEqual(plain.scenarios[name]!.failure);
      expect(registered.scenarios[name]!.graph).toEqual(plain.scenarios[name]!.graph);
      expect(registered.scenarios[name]!.failed).toEqual(plain.scenarios[name]!.failed);
      expect(registered.scenarios[name]!.failure).toEqual(plain.scenarios[name]!.failure);
      if(["object","action","property"].includes(name)) expect(registered.scenarios[name]!.registrations[0]!.status).toBe("materialized");
      if(name==="duplicate") {
        const registrations=registered.scenarios[name]!.registrations;
        expect(registrations).toHaveLength(2);
        expect(new Set(registrations.map(r=>r.id)).size).toBe(2);
        expect(registrations.every(r=>r.callbacks===1 && r.status==="materialized")).toBe(true);
      }
      if(name==="absent") expect(registered.scenarios[name]!.registrations[0]!.status).toBe("unobserved");
      if(name==="throws"||name==="actionThrows") {
        expect(registered.scenarios[name]!.failed).toBe(true);
        expect(registered.scenarios[name]!.failure).toBe(name==="throws"?"supplier-sentinel":"action-sentinel");
      }
    });
  }
  it("does not evaluate an unused provider",()=>{
    expect(report.projects.registered!.producerCalls.unused).toBeUndefined();
    expect(report.projects.registered!.scenarios.unused!.registrations[0]!.status).toBe("unobserved");
  });

  it("keeps one addition ID across inherited configurations",()=>{
    const a=report.projects.registered!.scenarios.childA!.registrations;
    const b=report.projects.registered!.scenarios.childB!.registrations;
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[0]!.status).toBe("materialized");
    expect(b[0]!.status).toBe("materialized");
  });

  it("does not mistake one observed value for proof of provider stability",()=>{
    const registered=report.projects.registered!;
    expect(registered.callerValue).toBe("review:sample:2");
    expect(registered.producerCalls.changing).toBe(2);
    expect(registered.scenarios.changing!.registrations[0]!.callbacks).toBe(1);
    expect(registered.scenarios.changing!.graph[0]!.requested).toBe("review:sample:1");
  });

});
