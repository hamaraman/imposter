// M2 오라클 테스트: 면 위 스케치, 회전, 쉘, 패턴, 미러
import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { planeFromNormal, type CadDocument, type Feature, type SketchData, type SketchPlane } from "@my-cad/core";
import { initSolver, solveDocument } from "@my-cad/sketch";
import { buildDocument, meshShape } from "@my-cad/kernel";

const require = createRequire(new URL("./package.json", import.meta.url));
beforeAll(async () => {
  setOC((await opencascade({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") })) as never);
  await initSolver();
}, 60_000);

const build = (features: Feature[]) =>
  buildDocument(solveDocument({ format: "my-cad/1", parameters: [], features } as CadDocument).doc);

// 고정된 좌표로 만든 사각형 / 원 스케치
const rect = (plane: SketchPlane, x0: number, y0: number, x1: number, y1: number, extra: Partial<SketchData> = {}): SketchData => ({
  plane,
  points: [
    { id: "a", x: x0, y: y0, fixed: true }, { id: "b", x: x1, y: y0, fixed: true },
    { id: "c", x: x1, y: y1, fixed: true }, { id: "d", x: x0, y: y1, fixed: true },
    ...(extra.points ?? []),
  ],
  curves: [
    { id: "l1", kind: "line", p1: "a", p2: "b" }, { id: "l2", kind: "line", p1: "b", p2: "c" },
    { id: "l3", kind: "line", p1: "c", p2: "d" }, { id: "l4", kind: "line", p1: "d", p2: "a" },
    ...(extra.curves ?? []),
  ],
  constraints: [],
});
const circle = (plane: SketchPlane, x: number, y: number, r: number): SketchData => ({
  plane, points: [{ id: "o", x, y, fixed: true }], curves: [{ id: "c", kind: "circle", c: "o", r }], constraints: [],
});
const sketch = (id: string, sk: SketchData): Feature => ({ id, type: "sketch", name: id, params: {}, sketch: sk });
const extrude = (id: string, sketchId: string, distance: string, operation: "new" | "join" | "cut" = "new"): Feature =>
  ({ id, type: "extrude", name: id, sketchId, operation, params: { distance } });
const base = (): Feature[] => [sketch("s1", rect("XY", 0, 0, 40, 30)), extrude("e1", "s1", "10")]; // 40×30×10 = 12000

describe("면 위 스케치 (F-03)", () => {
  it("윗면(z=10)에 그린 원을 5mm 돌출하면 위로 올라간다", () => {
    const top = planeFromNormal([20, 15, 10], [0, 0, 1]);
    const r = build([...base(), sketch("s2", circle(top, 0, 0, 5)), extrude("e2", "s2", "5", "join")]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(12000 + Math.PI * 25 * 5, 3);
    expect(r.shape!.boundingBox.bounds[1][2]).toBeCloseTo(15, 4);
  });

  it("옆면(+X)에 그린 원을 잘라내기로 3mm 파고들기", () => {
    const side = planeFromNormal([40, 15, 5], [1, 0, 0]);
    const r = build([...base(), sketch("s2", circle(side, 0, 0, 2)), extrude("e2", "s2", "-3", "cut")]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(12000 - Math.PI * 4 * 3, 3);
  });

  it("메시가 면마다 평면 정보를 준다 (윗면 법선 = +Z)", () => {
    const r = build(base());
    const m = meshShape(r.shape!);
    expect(m.faces.length).toBe(6);
    expect(m.faceGroups.length).toBe(6);
    const top = m.faces.find((f) => f.planar && f.normal[2] > 0.99)!;
    expect(top.origin[2]).toBeCloseTo(10, 6);
  });
});

describe("회전 (Revolve)", () => {
  it("XZ 평면의 2×4 사각형을 Z축(스케치 Y축) 둘레로 360° = 파푸스 정리", () => {
    // 사각형 x 5~7, z 0~4 → 중심 반지름 6, 면적 8 → V = 2π·6·8
    const r = build([sketch("s1", rect("XZ", 5, 0, 7, 4)),
      { id: "r1", type: "revolve", name: "r", sketchId: "s1", axis: "Y", operation: "new", params: { angle: "360" } }]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(2 * Math.PI * 6 * 8, 3);
  });

  it("90°만 돌리면 1/4", () => {
    const r = build([sketch("s1", rect("XZ", 5, 0, 7, 4)),
      { id: "r1", type: "revolve", name: "r", sketchId: "s1", axis: "Y", operation: "new", params: { angle: "90" } }]);
    expect(r.volume).toBeCloseTo((2 * Math.PI * 6 * 8) / 4, 3);
  });

  it("스케치 안의 선(보조선)을 축으로 사용", () => {
    // 축: x=10 수직선. 사각형 x 12~14 → 축에서 반지름 2~4 → 중심 3
    const sk = rect("XZ", 12, 0, 14, 4, {
      points: [{ id: "q1", x: 10, y: 0, fixed: true }, { id: "q2", x: 10, y: 4, fixed: true }],
      curves: [{ id: "ax", kind: "line", p1: "q1", p2: "q2", construction: true }],
    });
    const r = build([sketch("s1", sk),
      { id: "r1", type: "revolve", name: "r", sketchId: "s1", axis: "ax", operation: "new", params: { angle: "360" } }]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(2 * Math.PI * 3 * 8, 3);
  });
});

describe("쉘 (Shell)", () => {
  it("윗면을 열고 두께 2", () => {
    const r = build([...base(), { id: "sh", type: "shell", name: "sh", openFace: "+Z", params: { thickness: "2" } }]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(12000 - 36 * 26 * 8, 3);
  });

  it("두께가 너무 크면 피처 오류, 바디는 유지", () => {
    const r = build([...base(), { id: "sh", type: "shell", name: "sh", openFace: "+Z", params: { thickness: "20" } }]);
    expect(r.errors.map((e) => e.featureId)).toEqual(["sh"]);
    expect(r.volume).toBeCloseTo(12000, 3);
  });
});

describe("쉘 + 필렛", () => {
  const filleted = (r: string, t: string): Feature[] => [...base(),
    { id: "fi", type: "fillet", name: "fi", params: { radius: r } },
    { id: "sh", type: "shell", name: "sh", openFace: "+Z", params: { thickness: t } }];

  it("두께 < 필렛 반지름이면 쉘이 된다", () => {
    const r = build(filleted("2", "1"));
    expect(r.errors).toEqual([]);
    expect(r.volume!).toBeLessThan(12000 * 0.5);
  });

  it("두께 = 필렛 반지름이면 조용히 무시되지 않고 오류로 알린다", () => {
    const r = build(filleted("1", "1"));
    expect(r.errors.map((e) => e.featureId)).toEqual(["sh"]);
    expect(r.errors[0].message).toMatch(/필렛 반지름/);
  });
});

describe("패턴 / 미러", () => {
  const hole = (): Feature[] => [...base(), sketch("s2", circle("XY", 5, 15, 2)), extrude("h", "s2", "10", "cut")];
  const holeVol = Math.PI * 4 * 10;

  it("구멍을 X 방향으로 10mm 간격 4개", () => {
    const r = build([...hole(),
      { id: "p", type: "pattern", name: "p", sourceId: "h", mode: "linear", axis: "X", params: { count: "4", distance: "10", angle: "360" } }]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(12000 - 4 * holeVol, 3);
  });

  it("원형 패턴: 원판에 구멍 6개", () => {
    const disk = circle("XY", 0, 0, 20);
    const r = build([sketch("s1", disk), extrude("e1", "s1", "5"),
      sketch("s2", circle("XY", 12, 0, 2)), extrude("h", "s2", "5", "cut"),
      { id: "p", type: "pattern", name: "p", sourceId: "h", mode: "circular", axis: "Z", params: { count: "6", distance: "0", angle: "360" } }]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(Math.PI * 400 * 5 - 6 * Math.PI * 4 * 5, 3);
  });

  it("YZ 평면 미러: 바디 밖으로 튀어나온 블록을 반대쪽에 복제", () => {
    const r = build([...base(), sketch("s2", rect("XY", 40, 10, 45, 20)), extrude("b", "s2", "10", "join"),
      { id: "m", type: "mirror", name: "m", sourceId: "b", plane: "YZ", params: {} }]);
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(12000 + 2 * 5 * 10 * 10, 3);
    const [[x0], [x1]] = r.shape!.boundingBox.bounds;
    expect([x0, x1].map((v) => +v.toFixed(4))).toEqual([-45, 45]);
  });

  it("없는 원본을 참조하면 오류", () => {
    const r = build([...base(), { id: "m", type: "mirror", name: "m", sourceId: "nope", plane: "YZ", params: {} }]);
    expect(r.errors.map((e) => e.featureId)).toEqual(["m"]);
  });
});
