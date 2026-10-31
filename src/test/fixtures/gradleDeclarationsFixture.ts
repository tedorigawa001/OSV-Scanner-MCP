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
