// 명세 F-03~F-06: 스케치 데이터 모델. 솔버(planegcs)와 커널(OCCT)은 이 형식만 보고 동작한다
export type SketchPlane = "XY" | "XZ" | "YZ";

export interface SkPoint { id: string; x: number; y: number; fixed?: boolean; }

export type SkCurve =
  | { id: string; kind: "line"; p1: string; p2: string; construction?: boolean }
  | { id: string; kind: "circle"; c: string; r: number; construction?: boolean }
  // 호는 중심 c에서 s → e 방향(반시계)으로 그린다
  | { id: string; kind: "arc"; c: string; s: string; e: string; r: number; construction?: boolean };

// 치수 값(value)은 수식 문자열이라 파라미터를 참조할 수 있다 (예: "width")
export type SkConstraint =
  | { id: string; kind: "coincident"; a: string; b: string }
  | { id: string; kind: "horizontal" | "vertical"; line: string }
  | { id: string; kind: "parallel" | "perpendicular"; a: string; b: string }
  | { id: string; kind: "equal"; a: string; b: string }
  | { id: string; kind: "pointOnLine"; point: string; line: string }
  | { id: string; kind: "tangent"; line: string; curve: string }
  | { id: string; kind: "distance"; a: string; b: string; value: string }
  | { id: string; kind: "length"; line: string; value: string }
  | { id: string; kind: "radius"; curve: string; value: string }
  | { id: string; kind: "coordinate"; point: string; axis: "x" | "y"; value: string };

export interface SketchData {
  plane: SketchPlane;
  points: SkPoint[];
  curves: SkCurve[];
  constraints: SkConstraint[];
}

export const emptySketch = (plane: SketchPlane): SketchData => ({ plane, points: [], curves: [], constraints: [] });

export const DIMENSION_KINDS = ["distance", "length", "radius", "coordinate"] as const;

// 2D 좌표 → 3D 좌표 (replicad의 기본 평면 방향과 같게 맞춤)
export function planeTo3d(plane: SketchPlane, x: number, y: number): [number, number, number] {
  switch (plane) {
    case "XY": return [x, y, 0];
    case "XZ": return [x, 0, y];
    case "YZ": return [0, x, y];
  }
}

// 스케치 요소를 지우면 그 요소를 참조하던 곡선·구속도 함께 지운다
export function removeSketchEntities(sk: SketchData, ids: Set<string>): SketchData {
  const curves = sk.curves.filter((c) => !ids.has(c.id) && !curvePoints(c).some((p) => ids.has(p)));
  // 곡선이 사라지며 어떤 곡선에도 속하지 않게 된 점은 정리
  const used = new Set(curves.flatMap(curvePoints));
  const points = sk.points.filter((p) => used.has(p.id));
  const alive = new Set([...points.map((p) => p.id), ...curves.map((c) => c.id)]);
  const exists = (id: string) => alive.has(id);
  const constraints = sk.constraints.filter((k) => !ids.has(k.id) && constraintRefs(k).every(exists));
  return { ...sk, points, curves, constraints };
}

export function curvePoints(c: SkCurve): string[] {
  return c.kind === "line" ? [c.p1, c.p2] : c.kind === "circle" ? [c.c] : [c.c, c.s, c.e];
}

export function constraintRefs(k: SkConstraint): string[] {
  switch (k.kind) {
    case "coincident": case "parallel": case "perpendicular": case "equal": case "distance": return [k.a, k.b];
    case "horizontal": case "vertical": case "length": return [k.line];
    case "pointOnLine": return [k.point, k.line];
    case "tangent": return [k.line, k.curve];
    case "radius": return [k.curve];
    case "coordinate": return [k.point];
  }
}
