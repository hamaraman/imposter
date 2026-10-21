// M3(구멍, 질량 특성, 3MF) + M5(면 따라가기) 오라클 테스트
import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { planeFromNormal, removeSketchEntities, type CadDocument, type Feature, type SketchData, type SketchPlane } from "@my-cad/core";
import { initSolver, solveDocument } from "@my-cad/sketch";
import { buildDocument, massProps, shapeTo3mf, weld } from "@my-cad/kernel";

const require = createRequire(new URL("./package.json", import.meta.url));
beforeAll(async () => {
  setOC((await opencascade({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") })) as never);
  await initSolver();
}, 60_000);

const doc = (features: Feature[], height = "10"): CadDocument =>
  ({ format: "my-cad/1", parameters: [{ name: "height", expr: height, unit: "mm" }], features });
const build = (d: CadDocument) => buildDocument(solveDocument(d).doc);

const rect = (plane: SketchPlane, w: number, h: number): SketchData => ({
  plane,
  points: [{ id: "a", x: 0, y: 0, fixed: true }, { id: "b", x: w, y: 0, fixed: true },
    { id: "c", x: w, y: h, fixed: true }, { id: "d", x: 0, y: h, fixed: true }],
  curves: [{ id: "l1", kind: "line", p1: "a", p2: "b" }, { id: "l2", kind: "line", p1: "b", p2: "c" },
    { id: "l3", kind: "line", p1: "c", p2: "d" }, { id: "l4", kind: "line", p1: "d", p2: "a" }],
  constraints: [],
});
const pointsSketch = (plane: SketchPlane, pts: [number, number][]): SketchData => ({
  plane, points: pts.map(([x, y], i) => ({ id: `q${i}`, x, y, fixed: true })), curves: [], constraints: [],
});
const sketch = (id: string, sk: SketchData): Feature => ({ id, type: "sketch", name: id, params: {}, sketch: sk });
const base: Feature[] = [sketch("s1", rect("XY", 40, 30)),
  { id: "e1", type: "extrude", name: "e1", sketchId: "s1", operation: "new", params: { distance: "height" } }];
const hole = (sketchId: string, kind: "simple" | "counterbore" | "countersink", depth: string, side: "in" | "out" = "in",
  head: [string, string] = ["8", "3"]): Feature =>
  ({ id: "h", type: "sketchHole", name: "h", sketchId, kind, side, params: { diameter: "4", depth, headDiameter: head[0], headDepth: head[1] } });

describe("M5 면 따라가기", () => {
  const boss = (follow: boolean): Feature[] => {
    const top = { ...planeFromNormal([20, 15, 10], [0, 0, 1]), follow };
    const circle: SketchData = { plane: top, points: [{ id: "o", x: 0, y: 0, fixed: true }],
      curves: [{ id: "c", kind: "circle", c: "o", r: 5 }], constraints: [] };
    return [...base, sketch("s2", circle),
      { id: "e2", type: "extrude", name: "e2", sketchId: "s2", operation: "join", params: { distance: "5" } }];
  };

  it("높이를 10 → 20으로 바꾸면 윗면 돌기도 같이 올라간다", () => {
    const r10 = build(doc(boss(true), "10")), r20 = build(doc(boss(true), "20"));
    expect(r10.shape!.boundingBox.bounds[1][2]).toBeCloseTo(15, 4);
    expect(r20.shape!.boundingBox.bounds[1][2]).toBeCloseTo(25, 4);
    expect(r20.volume).toBeCloseTo(40 * 30 * 20 + Math.PI * 25 * 5, 3);
    expect(r20.planes.s2.origin[2]).toBeCloseTo(20, 6);
  });

  it("따라가기를 끄면 처음 높이(z=10)에 남는다", () => {
    const r = build(doc(boss(false), "20"));
    expect(r.shape!.boundingBox.bounds[1][2]).toBeCloseTo(20, 4); // 돌기가 바디 안에 묻힘
    expect(r.volume).toBeCloseTo(40 * 30 * 20, 3);
  });

  it("따라갈 면이 없으면 스케치에 오류를 표시하고 이후 피처는 처음 평면으로 계산", () => {
    const side = { ...planeFromNormal([0, 0, 0], [0.6, 0.8, 0]), follow: true }; // 이런 방향의 면은 없음
    const circle: SketchData = { plane: side, points: [{ id: "o", x: 0, y: 0, fixed: true }],
      curves: [{ id: "c", kind: "circle", c: "o", r: 1 }], constraints: [] };
    const r = build(doc([...base, sketch("s2", circle)]));
    expect(r.errors.map((e) => e.featureId)).toEqual(["s2"]);
  });
});

describe("M3 구멍", () => {
  const topPts = (pts: [number, number][]) => sketch("s2", pointsSketch({ ...planeFromNormal([20, 15, 10], [0, 0, 1]), follow: true }, pts));
  const box = 40 * 30 * 10;

  it("관통 구멍 2개 (깊이 0)", () => {
    const r = build(doc([...base, topPts([[-10, 0], [10, 0]]), hole("s2", "simple", "0")]));
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(box - 2 * Math.PI * 4 * 10, 3);
  });

  it("깊이 5 막힌 구멍", () => {
    const r = build(doc([...base, topPts([[0, 0]]), hole("s2", "simple", "5")]));
    expect(r.volume).toBeCloseTo(box - Math.PI * 4 * 5, 3);
  });

  it("카운터보어: 머리 Ø8 깊이 3 + 관통 Ø4", () => {
    const r = build(doc([...base, topPts([[0, 0]]), hole("s2", "counterbore", "0")]));
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(box - (Math.PI * 16 * 3 + Math.PI * 4 * 7), 3);
  });

  it("접시머리(90°): 머리 Ø8 + 관통 Ø4", () => {
    const r = build(doc([...base, topPts([[0, 0]]), hole("s2", "countersink", "0")]));
    expect(r.errors).toEqual([]);
    const cone = (Math.PI * 2 / 3) * (16 + 8 + 4); // 높이 2, 반지름 4→2 원뿔대
    expect(r.volume).toBeCloseTo(box - (cone + Math.PI * 4 * 8), 3);
  });

  it("XY 평면(바닥)에서 '바깥쪽'으로 뚫으면 위로 파고든다", () => {
    const r = build(doc([...base, sketch("s2", pointsSketch("XY", [[20, 15]])), hole("s2", "simple", "4", "out")]));
    expect(r.volume).toBeCloseTo(box - Math.PI * 4 * 4, 3);
  });

  it("점이 없는 스케치는 안내 오류", () => {
    const r = build(doc([...base, sketch("s2", rect("XY", 5, 5)), hole("s2", "simple", "0")]));
    expect(r.errors[0].message).toMatch(/점/);
  });

  it("곡선을 지워도 혼자 있던 점(구멍 위치)은 남는다", () => {
    const sk = rect("XY", 5, 5);
    sk.points.push({ id: "lonely", x: 9, y: 9 });
    const out = removeSketchEntities(sk, new Set(["l1"]));
    expect(out.points.map((p) => p.id)).toContain("lonely");
    expect(out.curves.length).toBe(3);
  });
});

describe("M3 질량 특성 / 3MF", () => {
  it("40×30×10 박스: 표면적 3800, 무게중심 (20, 15, 5)", () => {
    const p = massProps(build(doc(base)).shape!);
    expect(p.volume).toBeCloseTo(12000, 4);
    expect(p.area).toBeCloseTo(3800, 4);
    p.centerOfMass.forEach((v, i) => expect(v).toBeCloseTo([20, 15, 5][i], 4));
  });

  it("3MF: ZIP 구조가 올바르고 메시가 닫혀 있다 (모든 모서리를 삼각형 2개가 공유)", () => {
    const shape = build(doc([...base, sketch("s2", pointsSketch({ ...planeFromNormal([20, 15, 10], [0, 0, 1]) }, [[0, 0]])),
      hole("s2", "simple", "0")])).shape!;
    const bytes = shapeTo3mf(shape);
    const dir = mkdtempSync(join(tmpdir(), "mycad-"));
    const file = join(dir, "t.3mf");
    writeFileSync(file, bytes);
    // 표준 ZIP 리더(파이썬 zipfile)로 열어서 CRC 검사 + 삼각형 수 확인
    const out = execFileSync("python3", ["-c", `
import zipfile,sys,re
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
m=z.read("3D/3dmodel.model").decode()
print(sorted(z.namelist()), m.count("<triangle "), m.count("<vertex "))`, file]).toString();
    expect(out).toContain("'3D/3dmodel.model'");
    expect(out).toContain("'[Content_Types].xml'");

    const m = shape.mesh({ tolerance: 0.01, angularTolerance: 5 });
    const { triangles } = weld(m.vertices, m.triangles);
    const edges = new Map<string, number>();
    for (let i = 0; i < triangles.length; i += 3)
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const [u, v] = [triangles[i + a], triangles[i + b]];
        const k = u < v ? `${u}-${v}` : `${v}-${u}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    const bad = [...edges.values()].filter((c) => c !== 2).length;
    expect(bad).toBe(0);
  });
});
