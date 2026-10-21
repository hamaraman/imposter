import { GcsWrapper, SolveStatus, DebugMode, init_planegcs_module, type SketchPrimitive } from "@salusoft89/planegcs";
import {
  constraintRefs, evaluate, resolveParameters, type CadDocument, type Scope, type SketchData, type SkConstraint, type SkCurve,
} from "@my-cad/core";

// planegcs(FreeCAD 스케처 솔버 WASM) 어댑터. 우리 스케치 형식 ↔ planegcs 프리미티브 변환만 담당한다
let gcs: GcsWrapper | undefined;

export async function initSolver(wasmUrl?: string): Promise<void> {
  if (gcs) return;
  const mod = await init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  gcs = new GcsWrapper(new mod.GcsSystem());
  gcs.debug_mode = DebugMode.NoDebug;
}

export type SketchStatus = "under" | "full" | "over";
export interface SolveResult {
  sketch: SketchData;
  dof: number;
  status: SketchStatus;
  conflicts: string[];   // 충돌한 구속 ID
  error?: string;
}

export function solveSketch(sk: SketchData, scope: Scope = {}): SolveResult {
  if (!gcs) throw new Error("솔버가 아직 준비되지 않았습니다 (initSolver 먼저 호출)");
  if (sk.points.length === 0) return { sketch: sk, dof: 0, status: "under", conflicts: [] };

  let prims: SketchPrimitive[];
  try { prims = toPrimitives(sk, scope); }
  catch (e) { return { sketch: sk, dof: -1, status: "over", conflicts: [], error: (e as Error).message }; }

  gcs.clear_data();
  let status;
  try {
    gcs.push_primitives_and_params(prims);
    status = gcs.solve();
  } catch (e) {
    return { sketch: sk, dof: -1, status: "over", conflicts: [], error: `솔버 오류: ${(e as Error).message}` };
  }
  const ok = status === SolveStatus.Success || status === SolveStatus.Converged;
  const conflicts = ok ? [] : gcs.get_gcs_conflicting_constraints().filter((id) => sk.constraints.some((k) => k.id === id));
  const dof = gcs.gcs.dof();
  if (!ok) return { sketch: sk, dof, status: "over", conflicts, error: "구속조건이 서로 충돌합니다" };

  gcs.apply_solution();
  const solved = new Map(gcs.sketch_index.get_primitives().map((p) => [p.id, p] as const));
  const points = sk.points.map((p) => {
    const s = solved.get(p.id) as { x: number; y: number } | undefined;
    return s ? { ...p, x: s.x, y: s.y } : p;
  });
  const curves = sk.curves.map((c): SkCurve => {
    const s = solved.get(c.id) as { radius?: number } | undefined;
    return c.kind !== "line" && s?.radius !== undefined ? { ...c, r: s.radius } : c;
  });
  return { sketch: { ...sk, points, curves }, dof, status: dof === 0 ? "full" : dof < 0 ? "over" : "under", conflicts };
}

function toPrimitives(sk: SketchData, scope: Scope): SketchPrimitive[] {
  const out: SketchPrimitive[] = [];
  const pt = new Map(sk.points.map((p) => [p.id, p]));
  const curve = new Map(sk.curves.map((c) => [c.id, c]));
  for (const p of sk.points) out.push({ id: p.id, type: "point", x: p.x, y: p.y, fixed: !!p.fixed });

  for (const c of sk.curves) {
    if (c.kind === "line") out.push({ id: c.id, type: "line", p1_id: c.p1, p2_id: c.p2 });
    else if (c.kind === "circle") out.push({ id: c.id, type: "circle", c_id: c.c, radius: c.r });
    else {
      const [cc, s, e] = [pt.get(c.c)!, pt.get(c.s)!, pt.get(c.e)!];
      let a0 = Math.atan2(s.y - cc.y, s.x - cc.x), a1 = Math.atan2(e.y - cc.y, e.x - cc.x);
      if (a1 <= a0) a1 += 2 * Math.PI;
      out.push({ id: c.id, type: "arc", c_id: c.c, radius: c.r, start_angle: a0, end_angle: a1, start_id: c.s, end_id: c.e });
      out.push({ id: `${c.id}__rules`, type: "arc_rules", a_id: c.id });
    }
  }

  const val = (k: { value: string }) => evaluate(k.value, scope);
  const kindOf = (id: string) => curve.get(id)?.kind;
  // 참조 대상이 사라진 구속은 무시 (편집 도중 잠깐 생길 수 있음)
  const exists = (id: string) => pt.has(id) || curve.has(id);
  for (const k of sk.constraints) {
    if (constraintRefs(k).every(exists)) out.push(...constraintToPrimitives(k, kindOf, curve, val));
  }
  return out;
}

function constraintToPrimitives(
  k: SkConstraint, kindOf: (id: string) => string | undefined, curve: Map<string, SkCurve>, val: (k: { value: string }) => number,
): SketchPrimitive[] {
  const id = k.id;
  switch (k.kind) {
    case "coincident": return [{ id, type: "p2p_coincident", p1_id: k.a, p2_id: k.b }];
    case "horizontal": return [{ id, type: "horizontal_l", l_id: k.line }];
    case "vertical": return [{ id, type: "vertical_l", l_id: k.line }];
    case "parallel": return [{ id, type: "parallel", l1_id: k.a, l2_id: k.b }];
    case "perpendicular": return [{ id, type: "perpendicular_ll", l1_id: k.a, l2_id: k.b }];
    case "pointOnLine": return [{ id, type: "point_on_line_pl", p_id: k.point, l_id: k.line }];
    case "distance": {
      const d = val(k);
      if (d <= 0) throw new Error("거리는 0보다 커야 합니다");
      return [{ id, type: "p2p_distance", p1_id: k.a, p2_id: k.b, distance: d }];
    }
    case "length": {
      const l = curve.get(k.line);
      if (l?.kind !== "line") throw new Error("길이 치수는 선에만 줄 수 있습니다");
      const d = val(k);
      if (d <= 0) throw new Error("길이는 0보다 커야 합니다");
      return [{ id, type: "p2p_distance", p1_id: l.p1, p2_id: l.p2, distance: d }];
    }
    case "radius": {
      const r = val(k);
      if (r <= 0) throw new Error("반지름은 0보다 커야 합니다");
      return kindOf(k.curve) === "arc"
        ? [{ id, type: "arc_radius", a_id: k.curve, radius: r }]
        : [{ id, type: "circle_radius", c_id: k.curve, radius: r }];
    }
    case "coordinate":
      return k.axis === "x"
        ? [{ id, type: "coordinate_x", p_id: k.point, x: val(k) }]
        : [{ id, type: "coordinate_y", p_id: k.point, y: val(k) }];
    case "equal": {
      const [ka, kb] = [kindOf(k.a), kindOf(k.b)];
      if (ka === "line" && kb === "line") return [{ id, type: "equal_length", l1_id: k.a, l2_id: k.b }];
      if (ka === "circle" && kb === "circle") return [{ id, type: "equal_radius_cc", c1_id: k.a, c2_id: k.b }];
      if (ka === "arc" && kb === "arc") return [{ id, type: "equal_radius_aa", a1_id: k.a, a2_id: k.b }];
      if (ka === "circle" && kb === "arc") return [{ id, type: "equal_radius_ca", c1_id: k.a, a2_id: k.b }];
      if (ka === "arc" && kb === "circle") return [{ id, type: "equal_radius_ca", c1_id: k.b, a2_id: k.a }];
      throw new Error("동일 구속은 선끼리 또는 원/호끼리만 줄 수 있습니다");
    }
    case "tangent":
      return kindOf(k.curve) === "arc"
        ? [{ id, type: "tangent_la", l_id: k.line, a_id: k.curve }]
        : [{ id, type: "tangent_lc", l_id: k.line, c_id: k.curve }];
  }
}

// 문서 안의 모든 스케치를 현재 파라미터로 다시 풀어서 좌표를 갱신한다 (커널은 솔버를 모름)
export function solveDocument(doc: CadDocument): { doc: CadDocument; results: Record<string, SolveResult> } {
  let scope: Scope;
  try { scope = resolveParameters(doc); } catch { return { doc, results: {} }; }
  const results: Record<string, SolveResult> = {};
  const features = doc.features.map((f) => {
    if (f.type !== "sketch") return f;
    const r = solveSketch(f.sketch, scope);
    results[f.id] = r;
    return { ...f, sketch: r.sketch };
  });
  return { doc: { ...doc, features }, results };
}
