import { readFileSync } from "node:fs";
import { combineRelations } from "../../utils/dependencyRelations.js";
import { describe, expect, it } from "vitest";
import { parseGradleLock, analyzeGradleContext, parseGradleGraph } from "../../utils/gradleGraph.js";

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
