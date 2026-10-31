import { createHash } from "node:crypto";
import type { GradleGraph } from "../../utils/gradleGraph.js";

/** Many public roots sharing a forward fan-out; no runtime/artifact resolution is involved. */
export function syntheticGradleGraph(roots: number, modules: number, contextCount = 3, fanout = 4) {
  const configurations = Array.from({ length: contextCount }, (_, i) => `classpath${i}`);
  const lockText = Array.from({ length: modules }, (_, i) => `g:p${i}:1=${configurations.join(",")}\n`).join("");
  const graph: GradleGraph = {
    schema: "osv-mcp.gradle-graph", schemaVersion: 1,
    producer: { exporterVersion: "1", gradleVersion: "8.11.1" },
    lockfiles: [{ id: "lock", path: "gradle.lockfile", sha256: createHash("sha256").update(lockText).digest("hex") }],
    projects: [{ id: "main::", buildId: "main", projectPath: ":", directory: ".", ownerBuildFile: "build.gradle" }],
    inputs: { complete: false, files: [] }, contexts: [],
  };
  for (const configuration of configurations) {
    const context: GradleGraph["contexts"][number] = { id: configuration, projectId: "main::", kind: "project", configuration,
      lockfileId: "lock", lockConfiguration: configuration, complete: true, rootVariant: "root-v",
      components: [{ id: "root", kind: "project", projectId: "main::" }], variants: [{ id: "root-v", componentId: "root" }],
      edges: [], unresolved: [], unrepresentedDependencies: [], declarationEvidence: [] };
    const edge = (from: string, target: number) => context.edges.push({ fromVariant: from, selectedVariant: `v${target}`, constraint: false,
      requested: { kind: "module", group: "g", name: `p${target}`, selector: "1" } });
    for (let i = 0; i < modules; i++) {
      context.components.push({ id: `p${i}`, kind: "module", group: "g", name: `p${i}`, version: "1" });
      context.variants.push({ id: `v${i}`, componentId: `p${i}` });
      if (i < roots) { edge("root-v", i); if (roots < modules) edge(`v${i}`, roots); }
      else for (let offset = 1; offset <= fanout && i + offset < modules; offset++) edge(`v${i}`, i + offset);
    }
    graph.contexts.push(context);
  }
  return { graph, lockText };
}

/** Independent chains, optionally with one cross-root edge; same fixture for tests and benchmarks. */
export function syntheticGradleTrees(roots: number, modules: number, contextCount = 3, shared = false) {
  const fixture = syntheticGradleGraph(roots, modules, contextCount);
  for (const c of fixture.graph.contexts) {
    c.edges = [];
    for (let i = 0; i < modules; i++) c.edges.push({ fromVariant: i < roots ? "root-v" : `v${i - roots}`, selectedVariant: `v${i}`, constraint: false, requested: { kind: "unknown" } });
    if (shared) c.edges.push({ fromVariant: "v0", selectedVariant: "v1", constraint: false, requested: { kind: "unknown" } });
  }
  return fixture;
}
