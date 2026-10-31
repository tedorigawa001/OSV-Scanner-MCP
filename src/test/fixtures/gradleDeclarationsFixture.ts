import { graphFixture } from "./gradleGraphFixture.js";
import { createHash } from "node:crypto";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function declarationFixture() {
  const source = "// dependency declaration\n";
  const contract = JSON.stringify({ catalogPolicy: "none", contractVersion: 1, trustModel: "registered-helper-v1", sources: ["build.gradle"], scopes: [{
    id: "runtime", projectPath: ":", resolvableConfiguration: "runtimeClasspath", declarationConfigurations: ["implementation"],
    assertion: "all-contributing-additions-use-helper", mutationPolicy: "immutable-after-add",
  }] });
  const key = { version: 1, status: "supported", kind: "module", group: "g", name: "a",
    versionConstraint: { required: "1", preferred: "", strict: "", rejected: [], branch: null }, attributes: [], capabilitySelectors: [] };
  const shape = { version: 1, status: "supported", artifacts: [], targetConfiguration: null, endorseStrictVersions: false, transitive: true, excludes: [] };
  const v1 = graphFixture();
  const graph = { ...v1, schemaVersion: 2, inputs: { complete: false, files: [
    { path: "build.gradle", sha256: hash(source) }, { path: "osv-mcp-gradle-declarations.json", sha256: hash(contract) },
  ] }, contexts: v1.contexts.map(c => ({ ...c,
    edges: c.edges.map((e, i) => ({ ...e, id: `e${i}`, resolutionKey: i === 0 ? key : { ...key, name: "b", versionConstraint: { ...key.versionConstraint, required: "2" } } })),
    catalogInputs: { inventoryComplete: true, entries: [] },
    declarations: { adapterVersion: 2, inventoryComplete: true,
      trust: { model: "registered-helper-v1", contractPath: "osv-mcp-gradle-declarations.json", contractSha256: hash(contract), scopeId: "runtime" },
      configurationClosure: ["runtimeClasspath", "implementation"], configurationTopology: [
        { name: "runtimeClasspath", extendsFrom: ["implementation"], hasDependencies: false },
        { name: "implementation", extendsFrom: [], hasDependencies: true },
      ], records: [{ id: "d0", state: "materialized", ownerProjectId: c.projectId, configuration: "implementation",
        declarationAtAdd: { key, shape }, declarationAtResolve: { key, shape },
        source: { kind: "build-script", path: "build.gradle", sha256: hash(source) }, catalogUses: [], reasons: [] }],
      bindings: [{ edgeId: "e0", declarationIds: ["d0"], complete: true, reasons: [] }], reasons: [],
    },
  })) };
  return { graph, contract, source };
}

/** Independent contexts, with a bad declaration contract in only the second one. */
export function mixedTrustFixture(samePackage = false) {
  const data = declarationFixture(), c = data.graph.contexts[0]!;
  c.components = c.components.filter(p => p.id !== "b");
  c.variants = c.variants.filter(v => v.id !== "b-v");
  c.edges = c.edges.slice(0, 1);
  const other = structuredClone(c);
  other.id = "other"; other.configuration = "otherClasspath"; other.lockConfiguration = "otherClasspath";
  other.declarations.trust.scopeId = "other";
  other.declarations.configurationClosure[0] = "otherClasspath";
  other.declarations.configurationTopology[0]!.name = "otherClasspath";
  const name = samePackage ? "a" : "b", version = samePackage ? "1" : "2";
  for (const p of other.components) if (p.kind === "module") { p.name = name; p.version = version; }
  const edge = other.edges[0]!; edge.requested.name = name; edge.requested.selector = version;
  edge.resolutionKey.name = name; edge.resolutionKey.versionConstraint.required = version;
  const record = other.declarations.records[0]!;
  record.declarationAtAdd.key.name = name; record.declarationAtAdd.key.versionConstraint.required = version;
  record.declarationAtResolve.key.name = name; record.declarationAtResolve.key.versionConstraint.required = version;
  const contract = JSON.parse(data.contract);
  contract.scopes.push({ ...contract.scopes[0], id: "other", resolvableConfiguration: "otherClasspath" });
  data.contract = JSON.stringify(contract);
  data.graph.inputs.files.find(f => f.path === "osv-mcp-gradle-declarations.json")!.sha256 = hash(data.contract);
  c.declarations.trust.contractSha256 = hash(data.contract);
  other.declarations.trust.contractSha256 = "0".repeat(64);
  data.graph.contexts.push(other);
  const lock = samePackage ? "g:a:1=runtimeClasspath,otherClasspath\n" : "g:a:1=runtimeClasspath\ng:b:2=otherClasspath\n";
  data.graph.lockfiles[0]!.sha256 = hash(lock);
  return { ...data, lock };
}


export function providerDeclarationFixture() {
  const base = declarationFixture();
  const author = JSON.parse(base.contract);
  author.scopes[0].providerPolicy = "stable-during-export";
  const contract = JSON.stringify(author);
  const graph = { ...base.graph, contexts: base.graph.contexts.map(c => ({ ...c, declarations: {
    ...c.declarations, adapterVersion: 3, trust: { ...c.declarations.trust, contractSha256: hash(contract) },
    records: c.declarations.records.map(r => ({ ...r, registrationKind: "provider", declarationAtAdd: null as typeof r.declarationAtAdd | null,
      callbackCount: 1, materializations: [structuredClone(r.declarationAtAdd)] })),
  } })) };
  graph.inputs.files.find(f => f.path === "osv-mcp-gradle-declarations.json")!.sha256 = hash(contract);
  return { ...base, graph, contract };
}


export function catalogDeclarationFixture() {
  const base = providerDeclarationFixture();
  const toml = '[libraries]\nparent = "g:a:1"\nsame = "g:a:1"\n[bundles]\npair = ["parent", "same"]\n';
  const author = JSON.parse(base.contract);
  author.contractVersion = 2; author.catalogPolicy = "explicit-local-v1";
  author.catalogs = [{ id: "libs", name: "libs", kind: "local-toml", tomlPaths: ["gradle/libs.versions.toml"],
    inputPaths: ["settings.gradle", "gradle/libs.versions.toml", "catalog/optional.versions.toml"],
    constructionPolicy: "registered-inputs-only", mutationPolicy: "immutable-during-export", overridePolicy: "none",
    inputCompletenessAssertion: "all-catalog-construction-inputs-listed", bundleMembers: { pair: ["parent", "same"] } }];
  author.scopes[0].catalogIds = ["libs"];
  const contract = JSON.stringify(author);
  const graph = { ...base.graph, inputs: { ...base.graph.inputs, files: [...base.graph.inputs.files, { path: "catalog/optional.versions.toml", absent: true, sha256: undefined }] }, contexts: base.graph.contexts.map(c => {
    const template = c.declarations.records[0]!;
    const source = template.source;
    return { ...c, catalogInputs: { inventoryComplete: true, entries: [{ id: "libs", kind: "local-toml", state: "verifiable",
      graphInputPaths: author.catalogs[0].inputPaths as string[], reason: null }] }, declarations: { ...c.declarations, adapterVersion: 4,
      trust: { ...c.declarations.trust, contractSha256: hash(contract) },
      catalogAdditions: [{ id: "group", ownerProjectId: c.projectId, configuration: "implementation", source,
        catalogInputId: "libs", kind: "bundle", alias: "pair", normalizedAlias: "pair", registrationForm: "provider",
        callbackCount: 2, observationComplete: true, memberIds: ["d0", "d1"], reasons: [] as string[] }],
      records: ["d0", "d1"].map(id => ({ ...structuredClone(template), id, registrationKind: "bundle-member", registrationForm: "provider", catalogGroupId: "group",
        catalogUses: [{ catalogInputId: "libs", alias: "pair" }] })),
      bindings: [{ edgeId: "e0", declarationIds: ["d0", "d1"], complete: true, reasons: [] as string[] }],
    } };
  }) };
  const settings = "rootProject.name='catalog-test'\n";
  graph.inputs.files = [ ...graph.inputs.files.filter(f => f.path !== "osv-mcp-gradle-declarations.json"),
    { path: "osv-mcp-gradle-declarations.json", sha256: hash(contract) },
    { path: "settings.gradle", sha256: hash(settings) }, { path: "gradle/libs.versions.toml", sha256: hash(toml) } ];
  return { graph, contract, source: base.source, toml, settings };
}
