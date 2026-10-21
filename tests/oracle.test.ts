// 명세 인수 기준을 해석해(정답 공식)로 자동 검증하는 오라클 테스트
import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { newDocument, evaluate, History, setParameter, toggleSuppress, type CadDocument } from "@my-cad/core";
import { buildDocument } from "@my-cad/kernel";

const require = createRequire(new URL("./package.json", import.meta.url));

beforeAll(async () => {
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  setOC((await opencascade({ locateFile: () => wasm })) as never);
}, 60_000);

const docWith = (features: CadDocument["features"], params: CadDocument["parameters"] = []): CadDocument =>
  ({ format: "my-cad/1", parameters: params, features });

describe("수식 (F-06, F-17)", () => {
  it("우선순위, 괄호, 파라미터", () => {
    expect(evaluate("width/2 + 3", { width: 10 })).toBe(8);
    expect(evaluate("2*(3+4)^2", {})).toBe(98);
    expect(evaluate("-pi", {})).toBeCloseTo(-Math.PI);
  });
  it("허용되지 않는 입력은 거부", () => {
    expect(() => evaluate("alert(1)", {})).toThrow();
    expect(() => evaluate("unknown + 1", {})).toThrow(/알 수 없는/);
  });
});

describe("커널 오라클", () => {
  it("F-08: 10×10×5 돌출 = 500 mm³", () => {
    const r = buildDocument(docWith([{ id: "a", type: "box", name: "b", params: { width: "10", depth: "10", height: "5" } }]));
    expect(r.errors).toEqual([]);
    expect(r.volume).toBeCloseTo(500, 6);
  });

  it("F-10: 모든 모서리 R2 필렛 정육면체 = 해석해", () => {
    // 한 변 a, 반지름 r 인 정육면체의 모든 모서리·꼭짓점을 둥글게: 
    // V = a³ − 3·(4 − π)·r²·(a − 2r) − 8·(1 − π/6)·r³  ... 모서리 12개(4개씩 3방향) + 꼭짓점 8개 보정
    const a = 10, r = 2;
    const expected = a ** 3 - 3 * (4 - Math.PI) * r * r * (a - 2 * r) - (8 - (4 / 3) * Math.PI) * r ** 3;
    const res = buildDocument(docWith([
      { id: "a", type: "box", name: "b", params: { width: `${a}`, depth: `${a}`, height: `${a}` } },
      { id: "f", type: "fillet", name: "f", params: { radius: `${r}` } },
    ]));
    expect(res.errors).toEqual([]);
    expect(res.volume!).toBeCloseTo(expected, 3);
  });

  it("관통 구멍: 박스 − 원기둥", () => {
    const res = buildDocument(docWith([
      { id: "a", type: "box", name: "b", params: { width: "40", depth: "30", height: "10" } },
      { id: "h", type: "hole", name: "h", params: { diameter: "10", x: "0", y: "0" } },
    ]));
    expect(res.errors).toEqual([]);
    expect(res.volume!).toBeCloseTo(40 * 30 * 10 - Math.PI * 25 * 10, 3);
  });

  it("실패한 피처는 오류로 기록하고 이전 형상 유지", () => {
    const res = buildDocument(docWith([
      { id: "a", type: "box", name: "b", params: { width: "10", depth: "10", height: "5" } },
      { id: "f", type: "fillet", name: "f", params: { radius: "50" } },
    ]));
    expect(res.errors.map((e) => e.featureId)).toEqual(["f"]);
    expect(res.volume).toBeCloseTo(500, 6);
  });
});

describe("파라메트릭 재계산 + Undo (F-16, F-21)", () => {
  it("파라미터를 바꾸면 모델이 다시 계산되고, Undo로 원래대로", () => {
    const h = new History(newDocument());
    h.run(toggleSuppress("f2")); h.run(toggleSuppress("f3")); // 박스만 남김
    expect(buildDocument(h.current).volume).toBeCloseTo(40 * 30 * 10, 6);
    h.run(setParameter("height", "20"));
    expect(buildDocument(h.current).volume).toBeCloseTo(40 * 30 * 20, 6);
    h.undo();
    expect(buildDocument(h.current).volume).toBeCloseTo(40 * 30 * 10, 6);
  });
});
