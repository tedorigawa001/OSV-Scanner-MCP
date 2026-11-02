import { parseCatalogTrust, startupCatalogTrust, resetDeclarationTrustForTests } from "../../utils/gradleDeclarations.js";
import { mkdtemp, realpath, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { GradleGraphCache, sha256 } from "../../utils/gradleGraphCache.js";
import { declarationFixture, mixedTrustFixture, providerDeclarationFixture, catalogDeclarationFixture } from "../fixtures/gradleDeclarationsFixture.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const lock = "g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\n";
async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-gradle-declarations-test-"))); dirs.push(dir);
  const data = declarationFixture(); data.graph.lockfiles[0]!.sha256 = sha256(lock);
  for (const [name, bytes] of Object.entries({ "gradle.lockfile": lock, "build.gradle": data.source,
    "osv-mcp-gradle-declarations.json": data.contract, "osv-mcp-gradle-dependencies.json": JSON.stringify(data.graph) })) await writeFile(path.join(dir, name), bytes);
  return { dir, ...data };
}
it("adopts complete physical declarations only with the consumer's explicit trust setting", async () => {
  const {dir} = await fixture();
  const accepted = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(accepted.lookup!("g:a", "1")).toMatchObject({ relation: "direct", declaredIn: new Set(["build.gradle"]), declaredInComplete: true });
  expect(accepted.lookup!("g:b", "2")).toMatchObject({ relation: "transitive", introducedBy: new Set(["g:a"]) });
  expect(accepted.metadata.declarations_complete).toBe(true);
  expect(accepted.metadata.declaration_provenance).toMatchObject({ trust_status: "accepted", assurance: "author-attested-and-structurally-checked" });
  const disabled = await new GradleGraphCache(dir, undefined, undefined).capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(disabled.lookup!("g:a", "1").declaredIn).toBeUndefined();
  expect(disabled.metadata.relations_complete).toBe(true);
});

it.each([
  ["unverified plugin source", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.records[0]!.source.kind="convention-plugin"; }],
  ["topology cycle", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.configurationTopology[1]!.extendsFrom=["runtimeClasspath"]; }],
  ["partial inventory", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.inventoryComplete=false; }],
  ["missing binding", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.bindings=[]; }],
  ["unbound extra attempt", (g: ReturnType<typeof declarationFixture>["graph"]) => { const d=g.contexts[0]!.declarations; d.records.push({...structuredClone(d.records[0]!),id:"d1"}); }],
  ["mutation", (g: ReturnType<typeof declarationFixture>["graph"]) => { const r=g.contexts[0]!.declarations.records[0]!; r.declarationAtResolve=structuredClone(r.declarationAtAdd); r.declarationAtResolve.key.versionConstraint.required="99"; }],
  ["nondefault shape", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.records[0]!.declarationAtAdd.shape.transitive=false; }],
  ["scope omission", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.configurationTopology[0]!.hasDependencies=true; }],
  ["orphan topology", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.configurationClosure.push("orphan"); }],
  ["other project record", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.records[0]!.ownerProjectId="other"; }],
  ["unverified source", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.inputs.files=g.inputs.files.filter(f=>f.path!=="build.gradle"); }],
  ["substitution", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.edges[0]!.resolutionKey.group="other"; }],
])("withholds all declarations for %s without losing graph relations", async (_name, mutate) => {
  const {dir,graph}=await fixture(); mutate(graph);
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.relations_complete).toBe(true);
  expect(result.metadata.declarations_complete).toBe(false);
  expect(result.lookup!("g:a","1").declaredIn).toBeUndefined();
  expect(result.lookup!("g:b","2").introducedBy).toEqual(new Set(["g:a"]));
  expect(result.coverageReasons).toEqual([]);
});
it("validates every equal attempt rather than trusting a complete binding",async()=>{
  const {dir,graph}=await fixture();const d=graph.contexts[0]!.declarations;
  d.records.push({...structuredClone(d.records[0]!),id:"d1"});d.bindings[0]!.declarationIds.push("d1");
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.declarations_complete).toBe(true);
  expect(result.lookup!("g:a","1").declaredIn).toEqual(new Set(["build.gradle"]));
});
it.each(["source", "contract", "symlink"])("invalidates stale or unreadable graph inputs (%s)",async kind=>{
  const {dir}=await fixture();const name=kind==="contract"?"osv-mcp-gradle-declarations.json":"build.gradle";
  if(kind==="symlink") { await rm(path.join(dir,name));await symlink("gradle.lockfile",path.join(dir,name)); }
  else await writeFile(path.join(dir,name),"changed");
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.lookup!("g:a","1").relation).toBe("unknown");expect(result.coverageReasons).toEqual([]);
});
it("keeps relation budgets independent when the declaration budget is exhausted",async()=>{
  const {dir}=await fixture();
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1",{index:0,traversal:0}).capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.relations_complete).toBe(true);expect(result.metadata.declarations_complete).toBe(false);
  expect(result.metadata.reasons).toContain("declaration_budget_exceeded");
  expect(result.lookup!("g:b","2").introducedBy).toEqual(new Set(["g:a"]));
});
it("does not adopt unverifiable catalog contexts even with a trust setting",async()=>{
  const {dir,graph}=await fixture();graph.contexts[0]!.catalogInputs.inventoryComplete=false;
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.lookup!("g:a","1").relation).toBe("unknown");expect(result.coverageReasons).toEqual([]);
});
it("rejects duplicate-key author contracts without adopting declarations",async()=>{
  const {dir,graph,contract}=await fixture();const invalid=contract.replace('"contractVersion":1','"contractVersion":1,"contractVersion":1');
  await writeFile(path.join(dir,"osv-mcp-gradle-declarations.json"),invalid);
  graph.inputs.files.find(f=>f.path==="osv-mcp-gradle-declarations.json")!.sha256=sha256(invalid);
  graph.contexts[0]!.declarations.trust.contractSha256=sha256(invalid);
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.declarations_complete).toBe(false);expect(result.metadata.relations_complete).toBe(true);
});

it.each(["duplicate record", "unknown record", "duplicate reference", "unknown edge"])("rejects structurally invalid declaration references (%s)",async kind=>{
  const {dir,graph}=await fixture();const d=graph.contexts[0]!.declarations;
  if(kind==="duplicate record") d.records.push(structuredClone(d.records[0]!));
  else if(kind==="unknown record") d.bindings[0]!.declarationIds=["unknown"];
  else if(kind==="duplicate reference") d.bindings[0]!.declarationIds=["d0","d0"];
  else d.bindings[0]!.edgeId="unknown";
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.reasons).toContain("invalid_or_over_budget_metadata");expect(result.lookup!("g:a","1").relation).toBe("unknown");
});

it("does not merge source evidence across ambiguous selected variants",async()=>{
  const {dir,graph}=await fixture();const c=graph.contexts[0]!;
  c.variants.push({id:"a-other",componentId:"a"});
  c.edges.push({...structuredClone(c.edges[0]!),id:"other-edge",selectedVariant:"a-other"});
  c.declarations.bindings.push({edgeId:"other-edge",declarationIds:["d0"],complete:true,reasons:[]});
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.relations_complete).toBe(true);expect(result.metadata.declarations_complete).toBe(false);
});

it.each([false, true])("keeps context trust and declaration adoption order-independent (same package=%s)", async samePackage => {
  const { dir } = await fixture();
  const data = mixedTrustFixture(samePackage);
  await writeFile(path.join(dir, "gradle.lockfile"), data.lock);
  await writeFile(path.join(dir, "osv-mcp-gradle-declarations.json"), data.contract);
  const results = [];
  for (const reverse of [false, true]) {
    const graph = { ...data.graph, contexts: reverse ? [...data.graph.contexts].reverse() : data.graph.contexts };
    await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
    const result = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(data.lock));
    expect(result.metadata.relations_complete).toBe(true);
    expect(result.metadata.declarations_complete).toBe(false);
    expect(result.metadata.declaration_provenance?.trust_status).toBe("invalid");
    expect(result.metadata.declaration_provenance?.assurance).toBeNull();
    expect(result.metadata.declaration_provenance?.contexts).toEqual([
      { configuration: "otherClasspath", trust_status: "invalid", assurance: null, contract_paths: [] },
      { configuration: "runtimeClasspath", trust_status: "accepted", assurance: "author-attested-and-structurally-checked", contract_paths: ["osv-mcp-gradle-declarations.json"] },
    ]);
    const info = result.lookup!("g:a", "1");
    expect(info.relation).toBe("direct");
    if (samePackage) {
      expect(info.declaredIn).toBeUndefined();
      expect(info.declaredInComplete).toBe(false);
    } else {
      expect(info.declaredIn).toEqual(new Set(["build.gradle"]));
      expect(info.declaredInComplete).toBe(true);
      expect(result.lookup!("g:b", "2").declaredIn).toBeUndefined();
    }
    results.push({ provenance: result.metadata.declaration_provenance, declaredIn: info.declaredIn ? [...info.declaredIn] : null });
  }
  expect(results[0]).toEqual(results[1]);
});


it.each(["accepted", "reobserved", "missing-policy", "unobserved", "unstable", "count-mismatch", "overflow", "at-add-forgery", "unknown-adapter", "sync-forgery"])("recomputes Provider completeness from static evidence (%s)", async kind => {
  const { dir } = await fixture();
  const data = providerDeclarationFixture(), d = data.graph.contexts[0]!.declarations, r = d.records[0]!;
  data.graph.lockfiles[0]!.sha256 = sha256(lock);
  if (kind === "missing-policy") {
    const author = JSON.parse(data.contract); delete author.scopes[0].providerPolicy;
    data.contract = JSON.stringify(author);
    data.graph.inputs.files.find(f => f.path === "osv-mcp-gradle-declarations.json")!.sha256 = sha256(data.contract);
    d.trust.contractSha256 = sha256(data.contract);
  }
  if (kind === "reobserved") { r.materializations.push(structuredClone(r.materializations[0]!)); r.callbackCount++; }
  if (kind === "unobserved") { r.callbackCount = 0; r.materializations = []; }
  if (kind === "unstable") { const other = structuredClone(r.materializations[0]!); other.key.versionConstraint.required = "99"; r.materializations.push(other); r.callbackCount++; }
  if (kind === "count-mismatch") r.callbackCount++;
  if (kind === "overflow") { r.callbackCount = 129; r.materializations = Array.from({ length: 128 }, () => structuredClone(r.materializations[0]!)); }
  if (kind === "at-add-forgery") r.declarationAtAdd = structuredClone(r.materializations[0]!);
  if (kind === "unknown-adapter") d.adapterVersion = 999;
  if (kind === "sync-forgery") { r.registrationKind = "synchronous"; r.declarationAtAdd = structuredClone(r.materializations[0]!); }
  await writeFile(path.join(dir, "osv-mcp-gradle-declarations.json"), data.contract);
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(data.graph));
  const result = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(result.metadata.relations_complete, JSON.stringify(result.metadata)).toBe(true);
  expect(result.lookup!("g:b", "2").introducedBy).toEqual(new Set(["g:a"]));
  expect(result.coverageReasons).toEqual([]);
  if (kind === "accepted" || kind === "reobserved") {
    expect(result.metadata.declarations_complete).toBe(true);
    expect(result.lookup!("g:a", "1").declaredIn).toEqual(new Set(["build.gradle"]));
    expect(result.metadata.declaration_provenance!.limitations).toEqual([
      "unregistered_equal_additions_not_detectable", "reverted_external_mutations_not_detectable",
      "provider_evaluations_outside_materialization_not_observable", "provider_stability_author_asserted",
    ]);
  } else {
    expect(result.metadata.declarations_complete).toBe(false);
    expect(result.lookup!("g:a", "1").declaredIn).toBeUndefined();
  }
});


async function catalogFixture() {
  const { dir } = await fixture();
  const data = catalogDeclarationFixture();
  data.graph.lockfiles[0]!.sha256 = sha256(lock);
  await mkdir(path.join(dir, "gradle")); await mkdir(path.join(dir, "catalog"));
  await writeFile(path.join(dir, "settings.gradle"), data.settings);
  await writeFile(path.join(dir, "gradle/libs.versions.toml"), data.toml);
  return { dir, ...data };
}
async function saveCatalog(data: Awaited<ReturnType<typeof catalogFixture>>) {
  await writeFile(path.join(data.dir, "osv-mcp-gradle-declarations.json"), data.contract);
  await writeFile(path.join(data.dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(data.graph));
}
it.each(["accepted", "disabled", "invalid-policy", "declarations-disabled", "bad-count", "missing-member", "wrong-owner", "different-source", "wrong-alias", "duplicate-group", "wrong-module", "missing-scope", "false-complete", "member-kind", "group-form", "ungrouped-member"])("checks catalog group evidence and trust (%s)", async kind => {
  const data = await catalogFixture(), d = data.graph.contexts[0]!.declarations, group = d.catalogAdditions[0]!;
  if (kind === "bad-count") group.callbackCount++;
  if (kind === "missing-member") group.memberIds.pop();
  if (kind === "wrong-owner") group.ownerProjectId = "other";
  if (kind === "different-source") group.source = { ...group.source, path: "other.gradle" };
  if (kind === "wrong-alias") group.alias = "other";
  if (kind === "duplicate-group") d.catalogAdditions.push(structuredClone(group));
  if (kind === "wrong-module") {
    const file = data.toml.replaceAll("g:a:1", "other:a:1");
    await writeFile(path.join(data.dir, "gradle/libs.versions.toml"), file);
    data.graph.inputs.files.find(f => f.path === "gradle/libs.versions.toml")!.sha256 = sha256(file);
  }
  if (kind === "missing-scope") {
    const author = JSON.parse(data.contract); author.scopes[0].catalogIds = [];
    data.contract = JSON.stringify(author);
    data.graph.inputs.files.find(f => f.path === "osv-mcp-gradle-declarations.json")!.sha256 = sha256(data.contract);
    d.trust.contractSha256 = sha256(data.contract);
  }
  if (kind === "false-complete") group.observationComplete = false;
  if (kind === "member-kind") d.records[0]!.registrationKind = "provider";
  if (kind === "group-form") group.registrationForm = "provider-convertible";
  if (kind === "ungrouped-member") { d.catalogAdditions = []; d.records[0]!.catalogGroupId = "missing"; }
  await saveCatalog(data);
  const result = await new GradleGraphCache(data.dir, undefined, kind === "declarations-disabled" ? undefined : "registered-helper-v1", undefined,
    kind === "invalid-policy" ? parseCatalogTrust("local-catalog-inputs-V1") : kind === "disabled" ? undefined : "local-catalog-inputs-v1").capture(path.join(data.dir, "gradle.lockfile"), Buffer.from(lock));
  expect(result.metadata.relations_complete, JSON.stringify(result.metadata)).toBe(true);
  expect(result.coverageReasons).toEqual([]);
  if (kind === "accepted") {
    expect(result.metadata.declarations_complete, JSON.stringify(result.metadata)).toBe(true);
    expect(result.lookup!("g:a", "1").declaredIn).toEqual(new Set(["build.gradle"]));
    expect(result.metadata.declaration_provenance).toMatchObject({ catalog_trust_status: "accepted", catalog_trust_model: "local-catalog-inputs-v1" });
    expect(result.metadata.declaration_provenance!.limitations).toContain("catalog_inputs_author_attested");
    expect(result.metadata.declaration_provenance!.limitations).toContain("bundle_materialization_boundaries_not_observable");
  } else {
    expect(result.metadata.declarations_complete).toBe(false);
    expect(result.lookup!("g:a", "1").declaredIn).toBeUndefined();
    if (kind === "invalid-policy") expect(result.metadata.reasons).toContain("catalog_trust_config_invalid");
  }
});

it.each(["toml-stale", "generated-input", "manifest-path", "duplicate-id", "unknown-reference", "missing-input", "remote", "malformed-toml", "duplicate-key", "unsupported-plus-unverified"])("rejects catalog input evidence before graph adoption (%s)", async kind => {
  const data = await catalogFixture(), d = data.graph.contexts[0]!.declarations;
  const author = JSON.parse(data.contract);
  if (kind === "toml-stale") await writeFile(path.join(data.dir, "gradle/libs.versions.toml"), data.toml + "\n# changed");
  if (kind === "generated-input") await writeFile(path.join(data.dir, "catalog/optional.versions.toml"), "# generated");
  if (kind === "manifest-path") author.catalogs[0].inputPaths.push("../outside.versions.toml");
  if (kind === "duplicate-id") author.catalogs.push(structuredClone(author.catalogs[0]));
  if (kind === "unknown-reference") author.scopes[0].catalogIds = ["unknown"];
  if (kind === "missing-input") data.graph.inputs.files = data.graph.inputs.files.filter(f => f.path !== "gradle/libs.versions.toml");
  if (kind === "unsupported-plus-unverified") {
    // An unsupported first catalog must not skip the input check of the next one.
    author.catalogs[0].bundleMembers.pair = ["parent"];
    author.catalogs.push({ ...structuredClone(author.catalogs[0]), id: "tools", name: "tools", tomlPaths: ["catalog/tools.versions.toml"],
      inputPaths: ["settings.gradle", "catalog/tools.versions.toml"], bundleMembers: {} });
    for (const c of data.graph.contexts) c.catalogInputs.entries.push({ id: "tools", kind: "local-toml", state: "verifiable",
      graphInputPaths: ["settings.gradle", "catalog/tools.versions.toml"], reason: null });
  }
  if (kind === "remote") author.catalogs[0].kind = "remote";
  if (kind === "malformed-toml") {
    const file = "[broken"; await writeFile(path.join(data.dir, "gradle/libs.versions.toml"), file);
    data.graph.inputs.files.find(f => f.path === "gradle/libs.versions.toml")!.sha256 = sha256(file);
  }
  data.contract = JSON.stringify(author);
  if (kind === "duplicate-key") data.contract = data.contract.replace('"contractVersion":2', '"contractVersion":2,"contractVersion":2');
  data.graph.inputs.files.find(f => f.path === "osv-mcp-gradle-declarations.json")!.sha256 = sha256(data.contract);
  d.trust.contractSha256 = sha256(data.contract);
  await saveCatalog(data);
  const result = await new GradleGraphCache(data.dir, undefined, undefined).capture(path.join(data.dir, "gradle.lockfile"), Buffer.from(lock));
  expect(result.lookup!("g:a", "1").relation).toBe("unknown");
  expect(result.metadata.relations_complete).toBe(false); expect(result.coverageReasons).toEqual([]);
});


it.each(["oversized-bundle", "bundle-manifest", "missing-version-reference", "unknown-bundle-member"])("keeps verified relations when the catalog model is unsupported (%s)", async kind => {
  const data = await catalogFixture();
  let toml = data.toml;
  const author = JSON.parse(data.contract);
  if (kind === "oversized-bundle") {
    // Gradle accepts bundles beyond the 128 members this reader models.
    const names = Array.from({ length: 129 }, (_, i) => `m${i}`);
    toml = toml.replace("[bundles]", `${names.map(n => `${n} = "g:${n}:1"`).join("\n")}\n[bundles]`) + `big = [${names.map(n => `"${n}"`).join(",")}]\n`;
  }
  if (kind === "bundle-manifest") author.catalogs[0].bundleMembers.pair = ["parent"];
  if (kind === "missing-version-reference") toml = toml.replace('same = "g:a:1"', 'same = { module = "g:a", version.ref = "settings-only" }');
  if (kind === "unknown-bundle-member") toml = toml.replace('pair = ["parent", "same"]', 'pair = ["parent", "same", "settings-only"]');
  await writeFile(path.join(data.dir, "gradle/libs.versions.toml"), toml);
  data.graph.inputs.files.find(f => f.path === "gradle/libs.versions.toml")!.sha256 = sha256(toml);
  data.contract = JSON.stringify(author);
  data.graph.inputs.files.find(f => f.path === "osv-mcp-gradle-declarations.json")!.sha256 = sha256(data.contract);
  for (const c of data.graph.contexts) c.declarations.trust.contractSha256 = sha256(data.contract);
  await saveCatalog(data);
  const result = await new GradleGraphCache(data.dir, undefined, "registered-helper-v1", undefined, "local-catalog-inputs-v1").capture(path.join(data.dir, "gradle.lockfile"), Buffer.from(lock));
  expect(result.metadata.relations_complete, JSON.stringify(result.metadata)).toBe(true);
  expect(result.lookup!("g:a", "1").relation).toBe("direct");
  expect(result.coverageReasons).toEqual([]);
  expect(result.metadata.declarations_complete).toBe(false);
  expect(result.lookup!("g:a", "1").declaredIn).toBeUndefined();
  expect(result.metadata.reasons).toContain("unsupported_catalog_model");
  expect(result.metadata.reasons).not.toContain("catalog_graph_inputs_unverifiable");
  expect(result.metadata.declaration_provenance!.limitations).not.toContain("catalog_inputs_author_attested");
});

it("snapshots the catalog trust policy once and disables unknown settings", () => {
  expect(parseCatalogTrust(undefined)).toEqual({ trust: undefined, invalid: false });
  expect(parseCatalogTrust("local-catalog-inputs-v1")).toEqual({ trust: "local-catalog-inputs-v1", invalid: false });
  resetDeclarationTrustForTests();
  vi.stubEnv("OSV_MCP_GRADLE_CATALOG_TRUST", "local-catalog-inputs-V1");
  expect(startupCatalogTrust()).toEqual({ trust: undefined, invalid: true });
  vi.stubEnv("OSV_MCP_GRADLE_CATALOG_TRUST", "local-catalog-inputs-v1");
  expect(startupCatalogTrust()).toEqual({ trust: undefined, invalid: true });
  resetDeclarationTrustForTests();
});


it.each(["valid", "bundle-manifest", "stale-toml"] as const)("verifies captured catalog inputs even in graph schema v1 (%s)", async kind => {
  const data = await catalogFixture();
  const raw = JSON.parse(JSON.stringify(data.graph)); raw.schemaVersion = 1;
  for (const context of raw.contexts) {
    delete context.declarations; delete context.catalogInputs;
    for (const edge of context.edges) { delete edge.id; delete edge.resolutionKey; }
  }
  if (kind === "bundle-manifest") {
    const author = JSON.parse(data.contract); author.catalogs[0].bundleMembers.pair = ["same"];
    data.contract = JSON.stringify(author);
    raw.inputs.files.find((f: { path: string }) => f.path === "osv-mcp-gradle-declarations.json").sha256 = sha256(data.contract);
  }
  if (kind === "stale-toml") await writeFile(path.join(data.dir, "gradle/libs.versions.toml"), data.toml + "\n# changed");
  await writeFile(path.join(data.dir, "osv-mcp-gradle-declarations.json"), data.contract);
  await writeFile(path.join(data.dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(raw));
  const captured = await new GradleGraphCache(data.dir).capture(path.join(data.dir, "gradle.lockfile"), Buffer.from(lock));
  // A manifest that disagrees with the verified TOML only affects the declaration model; stale input rejects the graph.
  expect(captured.metadata.relations_complete).toBe(kind !== "stale-toml");
  if (kind === "bundle-manifest") expect(captured.metadata.reasons).toContain("unsupported_catalog_model");
  expect(captured.lookup!("g:a", "1").declaredIn).toBeUndefined();
  expect(captured.coverageReasons).toEqual([]);
});


it("rejects contract-v2 catalog input omission even when entries is empty", async () => {
  const data = await catalogFixture();
  data.graph.contexts[0]!.catalogInputs.entries = [];
  data.graph.inputs.files = data.graph.inputs.files.filter(f => f.path !== "gradle/libs.versions.toml");
  await saveCatalog(data);
  const captured = await new GradleGraphCache(data.dir, undefined, { trust: undefined, invalid: false }, undefined,
    { trust: undefined, invalid: false }).capture(path.join(data.dir, "gradle.lockfile"), Buffer.from(lock));
  expect(captured.metadata.relations_complete).toBe(false);
  expect(captured.lookup!("g:a", "1").relation).toBe("unknown");
  expect(captured.lookup!("g:a", "1").declaredIn).toBeUndefined();
  expect(captured.metadata.reasons).toContain("catalog_graph_inputs_unverifiable");
  expect(captured.coverageReasons).toEqual([]);
});


const catalogBypassCases = [2, 3, 4].flatMap(adapter => [false, true].flatMap(emptyEntries =>
  (["none", "toml", "manifest"] as const).flatMap(missingInput => [false, true].flatMap(declarationTrust => [false, true].map(catalogTrust =>
    ({ adapter, emptyEntries, missingInput, declarationTrust, catalogTrust }))))));
it.each(catalogBypassCases)("requires catalog policy from the contract (adapter=$adapter empty=$emptyEntries missing=$missingInput declarations=$declarationTrust catalog=$catalogTrust)", async ({ adapter, emptyEntries, missingInput, declarationTrust, catalogTrust }) => {
  const data = await catalogFixture();
  const graph = JSON.parse(JSON.stringify(data.graph));
  const context = graph.contexts[0], d = context.declarations;
  if (emptyEntries) context.catalogInputs.entries = [];
  if (missingInput !== "none") graph.inputs.files = graph.inputs.files.filter((f: { path: string }) =>
    f.path !== (missingInput === "toml" ? "gradle/libs.versions.toml" : "osv-mcp-gradle-declarations.json"));
  if (adapter !== 4) {
    d.adapterVersion = adapter; delete d.catalogAdditions;
    for (const r of d.records) {
      delete r.registrationForm; delete r.catalogGroupId; r.catalogUses = [];
      if (adapter === 2) {
        r.declarationAtAdd = r.materializations[0];
        delete r.registrationKind; delete r.callbackCount; delete r.materializations;
      } else r.registrationKind = "provider";
    }
  }
  data.graph = graph; await saveCatalog(data);
  const captured = await new GradleGraphCache(data.dir, undefined,
    { trust: declarationTrust ? "registered-helper-v1" : undefined, invalid: false }, undefined,
    { trust: catalogTrust ? "local-catalog-inputs-v1" : undefined, invalid: false }).capture(path.join(data.dir, "gradle.lockfile"), Buffer.from(lock));
  const verifiedInputs = !emptyEntries && missingInput === "none";
  const adopted = verifiedInputs && adapter === 4 && declarationTrust && catalogTrust;
  expect(captured.metadata.relations_complete).toBe(verifiedInputs);
  expect(captured.metadata.declarations_complete).toBe(adopted);
  expect(captured.lookup!("g:a", "1").declaredIn).toEqual(adopted ? new Set(["build.gradle"]) : undefined);
  expect(captured.lookup!("g:a", "1").relation).toBe(verifiedInputs ? "direct" : "unknown");
  expect(captured.coverageReasons).toEqual([]);
  if (!verifiedInputs) expect(captured.metadata.reasons).toContain("catalog_graph_inputs_unverifiable");
  else if (declarationTrust) {
    expect(captured.metadata.declaration_provenance!.catalog_trust_status).toBe(catalogTrust ? "accepted" : "disabled");
    if (!catalogTrust) expect(captured.metadata.reasons).toContain("catalog_trust_disabled");
    else if (adapter !== 4) expect(captured.metadata.reasons).toContain("unsupported_catalog_adapter");
  }
});


it.each(["duplicate-key", "unknown-field", "invalid-json", "wrong-version"])("does not infer catalog absence from a malformed manifest with empty entries (%s)", async kind => {
  const data = await catalogFixture();
  data.graph.contexts[0]!.catalogInputs.entries = [];
  if (kind === "duplicate-key") data.contract = data.contract.replace('"contractVersion":2', '"contractVersion":2,"contractVersion":2');
  if (kind === "unknown-field") data.contract = data.contract.replace('{', '{"unknown":true,');
  if (kind === "invalid-json") data.contract = data.contract.slice(0, -1);
  if (kind === "wrong-version") data.contract = data.contract.replace('"contractVersion":2', '"contractVersion":1');
  data.graph.inputs.files.find(f => f.path === "osv-mcp-gradle-declarations.json")!.sha256 = sha256(data.contract);
  data.graph.contexts[0]!.declarations.trust.contractSha256 = sha256(data.contract);
  await saveCatalog(data);
  const captured = await new GradleGraphCache(data.dir, undefined, { trust: undefined, invalid: false }, undefined,
    { trust: undefined, invalid: false }).capture(path.join(data.dir, "gradle.lockfile"), Buffer.from(lock));
  expect(captured.metadata.relations_complete).toBe(false);
  expect(captured.metadata.reasons).toContain("catalog_graph_inputs_unverifiable");
  expect(captured.coverageReasons).toEqual([]);
});
it.each(['malformed-owned','valid-g0','owned-depth-budget'])('v4 %s preserves trusted declarations and original core freshness rules',async kind=>{
 const {ownedFixture}=await import('../fixtures/gradleOwnedFixture.js');
 const {rewriteOwned}=await import('../fixtures/gradleOwnedFixture.js');
 const {ownedDigest}=await import('../../utils/gradleOwnedJson.js');
 const {dir,graph}=await fixture();const legacy=await new GradleGraphCache(dir,undefined,'registered-helper-v1').capture(path.join(dir,'gradle.lockfile'),Buffer.from(lock));
 const v4=ownedFixture();v4.coreGraph=graph;rewriteOwned(v4,()=>true,v=>{if(v.binding)v.binding.coreGraphDigest=ownedDigest(graph);if('coreGraphDigest'in v)v.coreGraphDigest=ownedDigest(graph);});
 if(kind==='malformed-owned')v4.ownedOfferBundles=false;
 let text=JSON.stringify(v4);if(kind==='owned-depth-budget')text=text.replace(/"ownedOfferObjects":\[/,'"ownedOfferObjects":['+'['.repeat(150)+'0'+']'.repeat(150)+',');
 await writeFile(path.join(dir,'osv-mcp-gradle-dependencies.json'),text);
 const current=await new GradleGraphCache(dir,undefined,'registered-helper-v1').capture(path.join(dir,'gradle.lockfile'),Buffer.from(lock));
 expect(current.metadata.declaration_provenance).toEqual(legacy.metadata.declaration_provenance);expect(current.metadata.declarations_complete).toBe(true);expect(current.coverageReasons).toEqual(legacy.coverageReasons);
 for(const [name,version]of [['g:a','1'],['g:b','2']]as const)expect(current.lookup!(name,version)).toEqual(legacy.lookup!(name,version));
 expect(current.metadata.owned_manifest?.diagnosticEligible).toBe(false);
 await writeFile(path.join(dir,'build.gradle'),'// changed core input');
 const stale=await new GradleGraphCache(dir,undefined,'registered-helper-v1').capture(path.join(dir,'gradle.lockfile'),Buffer.from(lock));expect(stale.metadata.reasons).toContain('stale_input_hash');expect(stale.lookup!('g:a','1').relation).toBe('unknown');
});
