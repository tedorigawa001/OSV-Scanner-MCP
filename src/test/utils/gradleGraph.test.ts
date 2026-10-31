import { readFileSync } from "node:fs";
import { combineRelations } from "../../utils/dependencyRelations.js";
import { describe, expect, it } from "vitest";
import { parseGradleLock, analyzeGradleContext, parseGradleGraph, createGradleBudget } from "../../utils/gradleGraph.js";

import { syntheticGradleGraph, syntheticGradleTrees } from "../fixtures/gradleSyntheticGraph.js";
import { graphFixture } from "../fixtures/gradleGraphFixture.js";
describe("Gradle graph", () => {
  it("classifies selected releases through real edges and ignores root lock constraints", () => {
    const doc = graphFixture();
    doc.contexts[0]!.edges.push({ ...doc.contexts[0]!.edges[1]!, fromVariant: "root-v", constraint: true });
    const graph = parseGradleGraph(JSON.stringify(doc));
    const lock = parseGradleLock("g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\nempty=testRuntimeClasspath\n");
    const result = analyzeGradleContext(graph.contexts[0]!, lock);
    expect(result.lookup!("g:a", "1")).toMatchObject({ relation: "direct" });
    expect(result.lookup!("g:b", "2")).toMatchObject({ relation: "transitive", introducedBy: new Set(["g:a"]) });
    expect(result.lookup!("g:a", "1").declaredIn).toBeUndefined();
    expect(result.coverageReasons).toEqual([]);
  });
  it("rejects duplicate JSON keys, invalid schemas and dangling variants", () => {
    expect(() => parseGradleGraph('{"schema":1,"schema":2}')).toThrow();
    const doc = graphFixture(); doc.contexts[0]!.edges[0]!.selectedVariant = "missing";
    expect(() => parseGradleGraph(JSON.stringify(doc))).toThrow();
    expect(() => parseGradleGraph("[".repeat(130) + "0" + "]".repeat(130))).toThrow();
  });
  it("uses variant edges, handles cycles and multiple origins without self origins", () => {
    const doc = graphFixture(), c = doc.contexts[0]!;
    c.edges.push({ ...c.edges[0]!, selectedVariant: "b-v" }, { ...c.edges[0]!, fromVariant: "b-v", selectedVariant: "a-v" });
    const parsed = parseGradleGraph(JSON.stringify(doc));
    const result = analyzeGradleContext(parsed.contexts[0]!, parseGradleLock("g:a:1=runtimeClasspath\\ng:b:2=runtimeClasspath\\n".replaceAll("\\n", "\n")));
    expect(result.lookup!("g:a", "1")).toMatchObject({ relation: "direct", introducedBy: new Set(["g:b"]) });
    expect(result.lookup!("g:b", "2")).toMatchObject({ relation: "direct", introducedBy: new Set(["g:a"]) });
  });
  it("distinguishes scope gaps from absent relation metadata", () => {
    const graph = parseGradleGraph(JSON.stringify(graphFixture()));
    const result = analyzeGradleContext(graph.contexts[0]!, parseGradleLock("g:a:1=runtimeClasspath\n"));
    expect(result.coverageReasons).toContain("graph_modules_missing_from_lock");
    expect(result.lookup).toBeNull();
  });
  it("preserves verified direct evidence when a context has unresolved edges", () => {
    const c = parseGradleGraph(JSON.stringify(graphFixture())).contexts[0]!;
    c.complete = false;
    c.unresolved.push({ fromVariant: "root-v", requested: { kind: "unknown" }, reason: "resolution_failed" });
    const result = analyzeGradleContext(c, parseGradleLock("g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\n"));
    expect(result.lookup!("g:a", "1")).toMatchObject({ relation: "direct", introducedByComplete: false });
    expect(result.lookup!("g:b", "2")).toMatchObject({ relation: "unknown", declaredInComplete: false });
    expect(result.coverageReasons).toContain("unresolved_dependencies");
  });

});

it("preserves independent completeness across lockfiles, including direct results", () => {
  const complete = { relation: "direct" as const, introducedBy: new Set(["g:parent"]), declaredIn: new Set(["build.gradle"]), introducedByComplete: true, declaredInComplete: true };
  for (const reverse of [false, true]) {
    const merge = (other: typeof complete) => combineRelations(reverse ? [other, complete] : [complete, other]);
    expect(merge({ ...complete, introducedByComplete: false, declaredInComplete: false })).toMatchObject({ introducedBy: [], declaredIn: [] });
    expect(merge({ ...complete, introducedByComplete: false })).toMatchObject({ introducedBy: [], declaredIn: ["build.gradle"] });
    expect(merge({ ...complete, declaredInComplete: false })).toMatchObject({ introducedBy: ["g:parent"], declaredIn: [] });
  }
});

it("imports a real Gradle export with distinct test-fixture variants, BOM constraints and project substitution", () => {
  const graph = parseGradleGraph(readFileSync(new URL("../fixtures/gradle-variants.json", import.meta.url), "utf8"));
  const lock = parseGradleLock(readFileSync(new URL("../fixtures/gradle-variants.lock", import.meta.url), "utf8"));
  const c = graph.contexts[0]!;
  const result = analyzeGradleContext(c, lock);
  expect(result.coverageReasons).toEqual([]); expect(result.reasons).toEqual([]);
  expect(result.lookup!("commons-io:commons-io", "2.6").relation).toBe("transitive");
  expect(result.lookup!("org.junit.jupiter:junit-jupiter-api", "5.10.0")).toMatchObject({ relation: "direct" });
  expect(result.lookup!("org.junit.jupiter:junit-jupiter-api", "5.10.0").introducedBy?.has("org.junit:junit-bom")).not.toBe(true);
  const lib = c.components.find(p => p.kind === "project" && p.projectId === "main::lib")!;
  expect(c.variants.filter(v => v.componentId === lib.id).length).toBeGreaterThan(1);
  expect(c.components.some(p => p.kind === "module" && p.group === "acme")).toBe(false);
});

it("uses exact GAV identity and reports unlocked resolved modules as coverage gaps", () => {
  const c = parseGradleGraph(JSON.stringify(graphFixture())).contexts[0]!;
  expect(analyzeGradleContext(c, parseGradleLock("g:a:1.0=runtimeClasspath\ng:b:2=runtimeClasspath\n")).lookup).toBeNull();
  expect(analyzeGradleContext(c, parseGradleLock("empty=otherClasspath\n")).coverageReasons).toContain("graph_modules_missing_from_lock");
});
it("keeps verified scope gaps when relationship traversal exhausts its budget", () => {
  const c = parseGradleGraph(JSON.stringify(graphFixture())).contexts[0]!; c.complete = false;
  c.unresolved.push({ fromVariant: "root-v", requested: { kind: "unknown" }, reason: "resolution_failed" });
  const result = analyzeGradleContext(c, parseGradleLock("g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\n"), { index: 1000, traversal: 0 });
  expect(result.coverageReasons).toContain("unresolved_dependencies");
  expect(result.reasons).toContain("relationship_budget_exceeded"); expect(result.lookup).toBeNull();
});
it("never treats origins as complete for modules reached through a project dependency", () => {
  const withLib = (libEdges: [string, string][], keepModuleEdge = true) => {
    const doc = graphFixture(), c = doc.contexts[0]!;
    if (!keepModuleEdge) c.edges.pop();
    doc.projects.push({ id: "main::lib", buildId: "main", projectPath: ":lib", directory: "lib", ownerBuildFile: "lib/build.gradle" });
    c.components.push({ id: "lib", kind: "project", projectId: "main::lib" });
    c.variants.push({ id: "lib-v", componentId: "lib" });
    c.edges.push({ fromVariant: "root-v", selectedVariant: "lib-v", constraint: false, requested: { kind: "project", projectPath: ":lib" } as never });
    for (const [from, to] of libEdges) c.edges.push({ fromVariant: from, selectedVariant: to, constraint: false, requested: { kind: "module", group: "g", name: "b", selector: "2" } });
    return analyzeGradleContext(parseGradleGraph(JSON.stringify(doc)).contexts[0]!, parseGradleLock("g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\n"));
  };
  // a -> b and :lib -> b: g:a alone would be a partial origin list.
  const shared = withLib([["lib-v", "b-v"]]);
  expect(shared.lookup!("g:b", "2")).toMatchObject({ relation: "transitive", introducedByComplete: false });
  expect(combineRelations([shared.lookup!("g:b", "2")]).introducedBy).toEqual([]);
  // Only :lib -> b: transitive without any module origin, so the empty list is not complete either.
  const only = withLib([["lib-v", "b-v"]], false);
  expect(only.lookup!("g:b", "2")).toMatchObject({ relation: "transitive", introducedByComplete: false });
  expect(only.lookup!("g:b", "2").introducedBy).toBeUndefined();
  expect(only.lookup!("g:a", "1")).toMatchObject({ relation: "direct", introducedByComplete: true });
  // A module not on any project path keeps its complete origin list.
  const unaffected = withLib([]);
  expect(unaffected.lookup!("g:b", "2")).toMatchObject({ relation: "transitive", introducedBy: new Set(["g:a"]), introducedByComplete: true });
});

it("keeps complete origins for three large overlapping contexts within the shared scan budget", () => {
  const { graph, lockText } = syntheticGradleGraph(200, 1200);
  const budget = createGradleBudget(), parsed = parseGradleGraph(JSON.stringify(graph), budget), lock = parseGradleLock(lockText);
  const expected = new Set(Array.from({ length: 200 }, (_, i) => `g:p${i}`));
  for (const context of parsed.contexts) {
    const result = analyzeGradleContext(context, lock, budget);
    expect(result.reasons).toEqual([]);
    expect(result.lookup!("g:p1199", "1")).toMatchObject({ relation: "transitive", introducedBy: expected, introducedByComplete: true });
    expect(result.lookup!("g:p0", "1")).toMatchObject({ relation: "direct" });
  }
  expect(budget.traversal).toBeGreaterThan(0);
});

it("matches independent reachability on cyclic, variant-specific and project paths", () => {
  let seed = 19871;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let sample = 0; sample < 40; sample++) {
    const { graph, lockText } = syntheticGradleGraph(7, 35, 1);
    const c = graph.contexts[0]!;
    graph.projects.push({ id: "lib", buildId: "main", projectPath: ":lib", directory: "lib", ownerBuildFile: "lib/build.gradle" });
    c.components.push({ id: "lib", kind: "project", projectId: "lib" });
    c.variants.push({ id: "lib-v", componentId: "lib" }, { id: "other-v", componentId: "p0" });
    const ids = c.variants.map(v => v.id);
    for (let i = 0; i < 100; i++) c.edges.push({ fromVariant: ids[random(ids.length)]!, selectedVariant: ids[random(ids.length)]!, constraint: random(5) === 0, requested: { kind: "unknown" } });
    const parsed = parseGradleGraph(JSON.stringify(graph)).contexts[0]!;
    const components = new Map(parsed.components.map(v => [v.id, v]));
    const variants = new Map(parsed.variants.map(v => [v.id, components.get(v.componentId)!]));
    const keyOf = (v: string) => { const p = variants.get(v)!; return p.kind === "module" ? JSON.stringify([`${p.group}:${p.name}`, p.version]) : null; };
    const children = (v: string) => parsed.edges.filter(e => !e.constraint && e.fromVariant === v).map(e => e.selectedVariant);
    const walk = (roots: string[]) => { const seen = new Set<string>(), todo = [...roots]; while (todo.length) { const v = todo.pop()!; if (seen.has(v)) continue; seen.add(v); todo.push(...children(v)); } return seen; };
    const rootEdges = children(parsed.rootVariant), reachable = walk(rootEdges);
    const direct = new Set(rootEdges.map(keyOf).filter(k => k !== null));
    const projectKeys = new Set([...walk(rootEdges.filter(v => variants.get(v)!.kind === "project"))].map(keyOf));
    const origins = new Map<string, Set<string>>();
    for (const root of rootEdges) {
      const p = variants.get(root)!; if (p.kind !== "module") continue;
      for (const v of walk([root])) {
        const key = keyOf(v); if (!key || key === keyOf(root)) continue;
        const by = origins.get(key) ?? new Set<string>(); by.add(`${p.group}:${p.name}`); origins.set(key, by);
      }
    }
    const reached = new Set([...reachable].map(keyOf)), analysis = analyzeGradleContext(parsed, parseGradleLock(lockText));
    expect(analysis.lookup).not.toBeNull();
    for (let i = 0; i < 35; i++) {
      const key = JSON.stringify([`g:p${i}`, "1"]), info = analysis.lookup!(`g:p${i}`, "1");
      expect(info.relation).toBe(direct.has(key) ? "direct" : reached.has(key) ? "transitive" : "unknown");
      expect([...(info.introducedBy ?? [])].sort()).toEqual([...(origins.get(key) ?? [])].sort());
      expect(info.introducedByComplete).toBe(reached.has(key) && !projectKeys.has(key));
    }
  }
});
it("does not recurse on a long shared cycle", () => {
  const { graph, lockText } = syntheticGradleGraph(8, 15_000, 1, 4), c = graph.contexts[0]!;
  c.edges.push({ fromVariant: "v14999", selectedVariant: "v8", constraint: false, requested: { kind: "unknown" } });
  const result = analyzeGradleContext(parseGradleGraph(JSON.stringify(graph)).contexts[0]!, parseGradleLock(lockText));
  expect(result.reasons).toEqual([]);
  expect(result.lookup!("g:p14999", "1").introducedBy).toEqual(new Set(Array.from({ length: 8 }, (_, i) => `g:p${i}`)));
});

it("does not spend the origin budget on an incomplete context that cannot publish origins", () => {
  const { graph, lockText } = syntheticGradleGraph(200, 1200, 1), c = graph.contexts[0]!;
  c.complete = false;
  c.unresolved.push({ fromVariant: "root-v", requested: { kind: "unknown" }, reason: "resolution_failed" });
  const budget = createGradleBudget(); budget.traversal = 6000;
  const result = analyzeGradleContext(parseGradleGraph(JSON.stringify(graph)).contexts[0]!, parseGradleLock(lockText), budget);
  expect(result.reasons).toEqual(["incomplete_context"]);
  expect(result.coverageReasons).toContain("unresolved_dependencies");
  expect(result.lookup!("g:p0", "1")).toMatchObject({ relation: "direct", introducedByComplete: false });
  expect(result.lookup!("g:p1199", "1")).toMatchObject({ relation: "unknown", introducedByComplete: false });
  expect(result.lookup!("g:p1199", "1").introducedBy).toBeUndefined();
});

it.each([10_000, 50_000, 200_000])("does not publish partial origins when shared propagation exceeds %i operations", limit => {
  const { graph, lockText } = syntheticGradleGraph(200, 1200, 1), budget = createGradleBudget(); budget.traversal = limit;
  const result = analyzeGradleContext(parseGradleGraph(JSON.stringify(graph)).contexts[0]!, parseGradleLock(lockText), budget);
  expect(result.lookup).toBeNull(); expect(result.reasons).toContain("relationship_budget_exceeded");
  expect(result.coverageReasons).toEqual([]); expect(budget.traversal).toBeLessThan(0);
});

it("keeps 24 mostly independent large tree contexts complete with a single shared edge", () => {
  const { graph, lockText } = syntheticGradleTrees(400, 6000, 8, true), text = JSON.stringify(graph);
  expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024 * 1024);
  expect(Buffer.byteLength(text) * 3).toBeLessThan(64 * 1024 * 1024);
  const budget = createGradleBudget(), lock = parseGradleLock(lockText);
  for (let document = 0; document < 3; document++) {
    const parsed = parseGradleGraph(text, budget);
    for (const context of parsed.contexts) {
      const result = analyzeGradleContext(context, lock, budget);
      expect(result.reasons).toEqual([]);
      expect(result.lookup!("g:p5999", "1")).toMatchObject({ relation: "transitive", introducedBy: new Set(["g:p399"]), introducedByComplete: true });
      expect(result.lookup!("g:p5601", "1").introducedBy).toEqual(new Set(["g:p0", "g:p1"]));
      expect(result.lookup!("g:p1", "1")).toMatchObject({ relation: "direct", introducedBy: new Set(["g:p0"]) });
    }
  }
  expect(2_000_000 - budget.traversal).toBeLessThan(500_000);
});

it("keeps the lightweight path when only cross-origin revisits or private diamonds are expensive", () => {
  const chain = syntheticGradleGraph(100, 1200, 1, 1);
  const privateDag = syntheticGradleTrees(100, 1200, 1), c = privateDag.graph.contexts[0]!;
  for (let i = 0; i < 1200; i++) for (const offset of [200, 300]) if (i + offset < 1200)
    c.edges.push({ fromVariant: `v${i}`, selectedVariant: `v${i + offset}`, constraint: false, requested: { kind: "unknown" } });
  for (const [fixture, limit, expected] of [
    [chain, 125_000, new Set(Array.from({ length: 100 }, (_, i) => `g:p${i}`))],
    [privateDag, 11_000, new Set(["g:p99"])],
  ] as const) {
    const budget = createGradleBudget(); budget.traversal = limit;
    const context = parseGradleGraph(JSON.stringify(fixture.graph)).contexts[0]!;
    const result = analyzeGradleContext(context, parseGradleLock(fixture.lockText), budget);
    expect(result.reasons).toEqual([]);
    expect(result.lookup!("g:p1199", "1").introducedBy).toEqual(expected);
    expect(budget.traversal).toBeGreaterThan(0);
  }
});
