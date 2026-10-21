// M1 오라클 테스트: 스케치 → 솔버 → 프로필 → 돌출
import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { newDocument, History, setParameter, type CadDocument, type SketchData } from "@my-cad/core";
import { initSolver, solveDocument, solveSketch } from "@my-cad/sketch";
import { buildDocument } from "@my-cad/kernel";

const require = createRequire(new URL("./package.json", import.meta.url));

beforeAll(async () => {
  setOC((await opencascade({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") })) as never);
  await initSolver();
}, 60_000);

const build = (doc: CadDocument) => buildDocument(solveDocument(doc).doc);

// 엉성하게 그린 사각형 (사용자가 대충 클릭한 것처럼)
const roughRect = (): SketchData => ({
  plane: "XY",
  points: [{ id: "a", x: 0, y: 0, fixed: true }, { id: "b", x: 18, y: 1 }, { id: "c", x: 21, y: 9 }, { id: "d", x: -1, y: 11 }],
  curves: [
    { id: "l1", kind: "line", p1: "a", p2: "b" }, { id: "l2", kind: "line", p1: "b", p2: "c" },
    { id: "l3", kind: "line", p1: "c", p2: "d" }, { id: "l4", kind: "line", p1: "d", p2: "a" },
  ],
  constraints: [
    { id: "h1", kind: "horizontal", line: "l1" }, { id: "v1", kind: "vertical", line: "l2" },
    { id: "h2", kind: "horizontal", line: "l3" }, { id: "v2", kind: "vertical", line: "l4" },
    { id: "w", kind: "length", line: "l1", value: "20" },
  ],
});

const sketchDoc = (sketch: SketchData, distance = "5", extra: CadDocument["features"] = []): CadDocument => ({
  format: "my-cad/1", parameters: [],
  features: [
    { id: "s1", type: "sketch", name: "s", params: {}, sketch },
    { id: "e1", type: "extrude", name: "e", sketchId: "s1", operation: "new", params: { distance } },
    ...extra,
  ],
});

describe("솔버 (F-05, F-06)", () => {
  it("구속을 만족하도록 좌표를 바로잡고 남은 자유도를 알려준다", () => {
    const r = solveSketch(roughRect());
    const p = Object.fromEntries(r.sketch.points.map((q) => [q.id, q]));
    expect(p.b.x).toBeCloseTo(20, 6);
    expect(p.b.y).toBeCloseTo(0, 6);
    expect(p.c.x).toBeCloseTo(20, 6);
    expect(r.dof).toBe(1);       // 높이가 아직 안 정해짐
    expect(r.status).toBe("under");
  });

  it("치수를 하나 더 주면 완전 구속", () => {
    const sk = roughRect();
    sk.constraints.push({ id: "hh", kind: "length", line: "l2", value: "10" });
    const r = solveSketch(sk);
    expect(r.status).toBe("full");
    expect(r.dof).toBe(0);
  });

  it("서로 맞지 않는 치수는 충돌로 보고하고 좌표를 바꾸지 않는다", () => {
    const sk = roughRect();
    sk.constraints.push({ id: "x1", kind: "length", line: "l2", value: "10" }, { id: "x2", kind: "length", line: "l4", value: "7" });
    const r = solveSketch(sk);
    expect(r.status).toBe("over");
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.sketch).toBe(sk);
  });
});

describe("프로필 돌출 (F-08)", () => {
  it("20×10 사각형을 5mm 돌출 = 1000 mm³", () => {
    const sk = roughRect();
    sk.constraints.push({ id: "hh", kind: "length", line: "l2", value: "10" });
    const r = build(sketchDoc(sk));
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(1000, 4);
  });

  it("사각형 안의 원은 구멍이 된다", () => {
    const sk = roughRect();
    sk.constraints.push({ id: "hh", kind: "length", line: "l2", value: "10" });
    sk.points.push({ id: "o", x: 10, y: 5, fixed: true });
    sk.curves.push({ id: "c1", kind: "circle", c: "o", r: 3 });
    const r = build(sketchDoc(sk));
    expect(r.volume).toBeCloseTo(1000 - Math.PI * 9 * 5, 4);
  });

  it("선 두 개와 반원 호 두 개로 만든 슬롯", () => {
    // 길이 20, 폭 10 슬롯: 직사각형 20×10 + 반지름 5 원 하나 분량
    const sk: SketchData = {
      plane: "XY",
      points: [
        { id: "a", x: 0, y: 0, fixed: true }, { id: "b", x: 20, y: 0, fixed: true },
        { id: "c", x: 20, y: 10, fixed: true }, { id: "d", x: 0, y: 10, fixed: true },
        { id: "m1", x: 20, y: 5, fixed: true }, { id: "m2", x: 0, y: 5, fixed: true },
      ],
      curves: [
        { id: "l1", kind: "line", p1: "a", p2: "b" },
        { id: "r1", kind: "arc", c: "m1", s: "b", e: "c", r: 5 },
        { id: "l2", kind: "line", p1: "c", p2: "d" },
        { id: "r2", kind: "arc", c: "m2", s: "d", e: "a", r: 5 },
      ],
      constraints: [],
    };
    const r = build(sketchDoc(sk, "2"));
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo((200 + Math.PI * 25) * 2, 3);
  });

  it("잘라내기 돌출과 음수 거리", () => {
    const base = roughRect();
    base.constraints.push({ id: "hh", kind: "length", line: "l2", value: "10" });
    const cutter: SketchData = {
      plane: "XY", points: [{ id: "o", x: 10, y: 5, fixed: true }],
      curves: [{ id: "c", kind: "circle", c: "o", r: 2 }], constraints: [],
    };
    const doc = sketchDoc(base, "5", [
      { id: "s2", type: "sketch", name: "s2", params: {}, sketch: cutter },
      { id: "e2", type: "extrude", name: "cut", sketchId: "s2", operation: "cut", params: { distance: "5" } },
    ]);
    expect(build(doc).volume).toBeCloseTo(1000 - Math.PI * 4 * 5, 4);
    const down = sketchDoc(base, "-5");
    const r = build(down);
    expect(r.volume).toBeCloseTo(1000, 4);
  });

  it("XZ 평면 스케치는 Z 방향으로 서 있다", () => {
    const sk = { ...roughRect(), plane: "XZ" as const };
    sk.constraints.push({ id: "hh", kind: "length", line: "l2", value: "10" });
    const solved = solveDocument(sketchDoc(sk)).doc;
    const r = buildDocument(solved);
    const [[x0, , z0], [x1, , z1]] = r.shape!.boundingBox.bounds;
    expect([x0, x1, z0, z1].map((v) => +v.toFixed(4))).toEqual([0, 20, 0, 10]); // planeTo3d와 같은 방향
  });

  it("열린 프로필은 해당 피처만 오류", () => {
    const sk = roughRect();
    sk.curves.pop(); // 한 변을 지움
    const r = build(sketchDoc(sk));
    expect(r.errors.map((e) => e.featureId)).toEqual(["e1"]);
  });
});

describe("기본 예제 문서 (파라메트릭)", () => {
  it("width를 바꾸면 스케치가 다시 풀리고 부피가 바뀐다", () => {
    const h = new History(newDocument());
    h.run((d) => { d.features = d.features.filter((f) => f.type !== "fillet"); return d; });
    const v = (w: number) => (w * 30 - Math.PI * (w / 8) ** 2) * 10;
    expect(build(h.current).volume).toBeCloseTo(v(40), 3);
    h.run(setParameter("width", "60"));
    expect(build(h.current).volume).toBeCloseTo(v(60), 3);
    const r = solveDocument(h.current).results.s1;
    expect(r.status).toBe("full");
  });
});
