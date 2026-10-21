import { evaluate, type Scope } from "./expr";
import type { SketchData } from "./sketch";

// 명세 F-17: 사용자 파라미터
export interface Parameter { name: string; expr: string; unit: "mm" | "deg" | ""; }

// 명세 F-08/F-10: M0에서 지원하는 피처. 값은 모두 수식 문자열
export type Feature =
  | { id: string; type: "box"; name: string; suppressed?: boolean;
      params: { width: string; depth: string; height: string } }
  | { id: string; type: "fillet"; name: string; suppressed?: boolean;
      params: { radius: string } }
  | { id: string; type: "hole"; name: string; suppressed?: boolean;
      params: { diameter: string; x: string; y: string } }
  // 명세 F-03: 스케치는 형상을 만들지 않고 이후 피처의 입력이 된다
  | { id: string; type: "sketch"; name: string; suppressed?: boolean; params: Record<string, never>; sketch: SketchData }
  // 명세 F-08: 스케치의 닫힌 프로필을 돌출
  | { id: string; type: "extrude"; name: string; suppressed?: boolean; sketchId: string;
      operation: ExtrudeOperation; params: { distance: string } }
  // 회전: 스케치 프로필을 축(스케치의 X/Y축 또는 스케치 안의 선) 둘레로 돌림
  | { id: string; type: "revolve"; name: string; suppressed?: boolean; sketchId: string;
      axis: string; operation: ExtrudeOperation; params: { angle: string } }
  // 쉘: 바디 끝의 한 면을 열고 안쪽으로 두께만 남김
  | { id: string; type: "shell"; name: string; suppressed?: boolean; openFace: ShellFace; params: { thickness: string } }
  // 패턴: 앞선 돌출/회전의 결과를 직선 또는 원형으로 복제 (같은 연산 적용)
  | { id: string; type: "pattern"; name: string; suppressed?: boolean; sourceId: string; mode: "linear" | "circular";
      axis: Axis; params: { count: string; distance: string; angle: string } }
  // 구멍(M3): 스케치의 점마다 구멍. 깊이 0 = 관통. 방향은 스케치 평면 법선의 반대(in) 또는 같은 쪽(out)
  | { id: string; type: "sketchHole"; name: string; suppressed?: boolean; sketchId: string;
      kind: "simple" | "counterbore" | "countersink"; side: "in" | "out";
      params: { diameter: string; depth: string; headDiameter: string; headDepth: string } }
  // 미러: 앞선 돌출/회전의 결과를 원점 평면에 대칭 복제
  | { id: string; type: "mirror"; name: string; suppressed?: boolean; sourceId: string; plane: "XY" | "XZ" | "YZ";
      params: Record<string, never> };

export type ExtrudeOperation = "new" | "join" | "cut";
export type Axis = "X" | "Y" | "Z";
export type ShellFace = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

export interface CadDocument {
  format: "my-cad/1";
  parameters: Parameter[];
  features: Feature[];   // 타임라인 순서 = 배열 순서 (F-16)
  rollbackIndex?: number; // 이 인덱스까지만 계산 (없으면 전체)
}

export function newDocument(): CadDocument {
  // 예제: 원점에 붙은 width×depth 사각형 + 가운데 구멍을 그린 스케치를 height만큼 돌출하고 모서리를 둥글게
  const P = (id: string, x: number, y: number, fixed = false) => ({ id, x, y, ...(fixed ? { fixed } : {}) });
  return {
    format: "my-cad/1",
    parameters: [
      { name: "width", expr: "40", unit: "mm" },
      { name: "depth", expr: "30", unit: "mm" },
      { name: "height", expr: "10", unit: "mm" },
    ],
    features: [
      {
        id: "s1", type: "sketch", name: "Profile", params: {},
        sketch: {
          plane: "XY",
          points: [P("p1", 0, 0, true), P("p2", 40, 0), P("p3", 40, 30), P("p4", 0, 30), P("p5", 20, 15)],
          curves: [
            { id: "l1", kind: "line", p1: "p1", p2: "p2" }, { id: "l2", kind: "line", p1: "p2", p2: "p3" },
            { id: "l3", kind: "line", p1: "p3", p2: "p4" }, { id: "l4", kind: "line", p1: "p4", p2: "p1" },
            { id: "c1", kind: "circle", c: "p5", r: 5 },
          ],
          constraints: [
            { id: "k1", kind: "horizontal", line: "l1" }, { id: "k2", kind: "vertical", line: "l2" },
            { id: "k3", kind: "horizontal", line: "l3" }, { id: "k4", kind: "vertical", line: "l4" },
            { id: "k5", kind: "length", line: "l1", value: "width" },
            { id: "k6", kind: "length", line: "l2", value: "depth" },
            { id: "k7", kind: "coordinate", point: "p5", axis: "x", value: "width/2" },
            { id: "k8", kind: "coordinate", point: "p5", axis: "y", value: "depth/2" },
            { id: "k9", kind: "radius", curve: "c1", value: "width/8" },
          ],
        },
      },
      { id: "f1", type: "extrude", name: "Body", sketchId: "s1", operation: "new", params: { distance: "height" } },
      { id: "f2", type: "fillet", name: "Round edges", params: { radius: "1" } },
    ],
  };
}

// 파라미터를 순서대로 계산. 앞쪽 파라미터만 참조 가능하므로 순환 참조가 생기지 않음
export function resolveParameters(doc: CadDocument): Scope {
  const scope: Scope = {};
  for (const p of doc.parameters) {
    if (!/^[A-Za-z_]\w*$/.test(p.name)) throw new Error(`파라미터 이름이 올바르지 않음: ${p.name}`);
    scope[p.name] = evaluate(p.expr, scope);
  }
  return scope;
}

// 피처 파라미터를 숫자로 변환
export function resolveFeature<F extends Feature>(f: F, scope: Scope): Record<keyof F["params"], number> {
  const out = {} as Record<string, number>;
  for (const [k, expr] of Object.entries(f.params)) out[k] = evaluate(expr as string, scope);
  return out as Record<keyof F["params"], number>;
}

export function activeFeatures(doc: CadDocument): Feature[] {
  const end = doc.rollbackIndex ?? doc.features.length;
  return doc.features.slice(0, end).filter((f) => !f.suppressed);
}

export function serialize(doc: CadDocument): string { return JSON.stringify(doc, null, 2); }

export function deserialize(text: string): CadDocument {
  const doc = JSON.parse(text);
  if (doc?.format !== "my-cad/1" || !Array.isArray(doc.features) || !Array.isArray(doc.parameters))
    throw new Error("지원하지 않는 파일 형식입니다");
  return doc as CadDocument;
}

export function nextId(doc: CadDocument, prefix: string): string {
  const used = new Set(doc.features.map((f) => f.id));
  let i = doc.features.length + 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}
