import { draw, drawRectangle, makeCylinder, measureArea, measureShapeVolumeProperties, measureVolume, Plane, type Shape3D } from "replicad";
import {
  activeFeatures, cross, planeFrame, planeTo3d, resolveFeature, resolveParameters, standalonePoints,
  type CadDocument, type CustomPlane, type ExtrudeOperation, type Feature, type SketchData, type SketchPlane, type Vec3,
} from "@my-cad/core";
import { sketchToDrawing } from "./profile";

// 커널 어댑터: OCCT(replicad) 호출은 이 패키지 안에서만 한다 (core는 커널을 모름)
export interface FeatureError { featureId: string; message: string; }
// 질량 특성 (M3): 부피 mm³, 표면적 mm², 무게중심, 바운딩 박스
export interface MassProps { volume: number; area: number; centerOfMass: Vec3; bounds: [Vec3, Vec3]; }
export interface BuildResult {
  shape?: Shape3D; errors: FeatureError[]; volume?: number; props?: MassProps;
  planes: Record<string, CustomPlane>; // 면을 따라간 스케치의 실제 평면 (화면 표시용)
}

// 돌출/회전이 만든 "도구" 형상을 기억해 두었다가 패턴·미러에서 다시 쓴다
interface Tool { shape: Shape3D; operation: ExtrudeOperation; }
interface Ctx {
  shape?: Shape3D; tools: Map<string, Tool>; doc: CadDocument; scope: Record<string, number>;
  planes: Map<string, SketchPlane>; // 스케치 ID → 이번 계산에서 쓴 평면
}

export function buildDocument(doc: CadDocument): BuildResult {
  const errors: FeatureError[] = [];
  let scope;
  try { scope = resolveParameters(doc); }
  catch (e) { return { errors: [{ featureId: "parameters", message: (e as Error).message }], planes: {} }; }

  const ctx: Ctx = { tools: new Map(), doc, scope, planes: new Map() };
  for (const f of activeFeatures(doc)) {
    try {
      // 실패한 피처는 건너뛰고 직전 형상을 유지 (명세 F-10 예외 처리)
      ctx.shape = applyFeature(f, ctx);
    } catch (e) {
      errors.push({ featureId: f.id, message: kernelMessage(e) });
    }
  }
  const planes: Record<string, CustomPlane> = {};
  ctx.planes.forEach((pl, id) => { if (typeof pl !== "string" && pl.follow) planes[id] = pl; });
  return { shape: ctx.shape, errors, volume: ctx.shape ? measureVolume(ctx.shape) : undefined, planes };
}

export function massProps(shape: Shape3D): MassProps {
  const vp = measureShapeVolumeProperties(shape);
  const props = { volume: vp.volume, area: measureArea(shape), centerOfMass: vp.centerOfMass as Vec3,
    bounds: shape.boundingBox.bounds as [Vec3, Vec3] };
  vp.delete();
  return props;
}

// M5: 면을 따라가는 스케치 평면 다시 찾기
// 같은 방향을 향하는 평평한 면 중, 처음 기준점에서 법선 방향 거리가 가장 가깝고(주) 면 중심이 가까운(보조) 면을 고른다.
// 새 원점 = 처음 원점을 그 면의 평면 위로 옮긴 점 (면 안에서의 위치는 유지하고 높이만 따라감)
export function followPlane(shape: Shape3D, plane: CustomPlane): CustomPlane | undefined {
  const n = planeFrame(plane).n;
  let best: { score: number; offset: number } | undefined;
  for (const face of shape.faces) {
    if (face.geomType !== "PLANE") continue;
    const fn = face.normalAt().toTuple();
    if (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] < 0.9999) continue;
    const c = face.center.toTuple();
    const d: Vec3 = [c[0] - plane.origin[0], c[1] - plane.origin[1], c[2] - plane.origin[2]];
    const offset = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    const inPlane = Math.hypot(d[0] - offset * n[0], d[1] - offset * n[1], d[2] - offset * n[2]);
    const score = Math.abs(offset) + 0.25 * inPlane;
    if (!best || score < best.score) best = { score, offset };
  }
  if (!best) return undefined;
  const origin = plane.origin.map((v, i) => v + n[i] * best!.offset) as Vec3;
  return { ...plane, origin };
}

// OCCT 예외는 숫자 포인터로 올라오는 경우가 있어서 사람이 읽을 수 있는 문장으로 바꿈
function kernelMessage(e: unknown): string {
  if (e instanceof Error && e.message && !/^\d+$/.test(e.message)) return e.message;
  return "형상 연산에 실패했습니다 (치수나 위치를 확인하세요)";
}

// 도구 형상을 현재 바디에 적용 (새 바디/결합 = 합치기, 잘라내기 = 빼기)
function combine(shape: Shape3D | undefined, tool: Shape3D, op: ExtrudeOperation): Shape3D {
  if (!shape) {
    if (op === "cut") throw new Error("잘라낼 바디가 없습니다");
    return tool;
  }
  // M2까지는 단일 바디: "새 바디"도 기존 바디와 합쳐서 보관
  return op === "cut" ? shape.cut(tool) : shape.fuse(tool);
}

// 기본 평면도 같은 좌표계(planeFrame)로 만들어서 한 가지 경로로 처리
function toPlane(plane: SketchPlane, offset = 0): Plane {
  const f = planeFrame(plane);
  const origin = f.origin.map((v, i) => v + f.n[i] * offset) as Vec3;
  return new Plane(origin, f.x, f.n);
}

function sketchOf(ctx: Ctx, sketchId: string): SketchData {
  const sk = ctx.doc.features.find((x) => x.id === sketchId);
  if (sk?.type !== "sketch") throw new Error("사용할 스케치를 찾을 수 없습니다");
  if (sk.suppressed) throw new Error("사용할 스케치가 억제되어 있습니다");
  const plane = ctx.planes.get(sketchId);
  if (!plane) throw new Error("스케치가 이 피처보다 뒤에 있어서 사용할 수 없습니다");
  return { ...sk.sketch, plane };
}

function applyFeature(f: Feature, ctx: Ctx): Shape3D | undefined {
  const { shape, scope } = ctx;
  switch (f.type) {
    case "sketch": {
      // 스케치는 형상을 바꾸지 않음. 면을 따라가는 평면이면 지금 바디에서 면을 다시 찾는다
      const pl = f.sketch.plane;
      ctx.planes.set(f.id, pl);
      if (typeof pl !== "string" && pl.follow) {
        const found = shape ? followPlane(shape, pl) : undefined;
        if (!found) throw new Error("따라갈 면을 찾을 수 없어서 처음 위치에 그립니다");
        ctx.planes.set(f.id, found);
      }
      return shape;
    }

    case "box": {
      const p = resolveFeature(f, scope);
      if (p.width <= 0 || p.depth <= 0 || p.height <= 0) throw new Error("치수는 0보다 커야 합니다");
      return drawRectangle(p.width, p.depth).sketchOnPlane("XY").extrude(p.height) as Shape3D;
    }

    case "extrude": {
      const sk = sketchOf(ctx, f.sketchId);
      const { distance } = resolveFeature(f, scope);
      if (Math.abs(distance) < 1e-9) throw new Error("돌출 거리는 0이 아니어야 합니다");
      // 음수 거리는 반대 방향: 평면을 그만큼 옮긴 뒤 양수로 돌출
      const tool = sketchToDrawing(sk).sketchOnPlane(toPlane(sk.plane, distance < 0 ? distance : 0))
        .extrude(Math.abs(distance)) as Shape3D;
      ctx.tools.set(f.id, { shape: tool.clone(), operation: f.operation });
      return combine(shape, tool, f.operation);
    }

    case "revolve": {
      const sk = sketchOf(ctx, f.sketchId);
      const { angle } = resolveFeature(f, scope);
      if (angle <= 0 || angle > 360) throw new Error("회전 각도는 0보다 크고 360 이하여야 합니다");
      const frame = planeFrame(sk.plane);
      let origin: Vec3 = frame.origin, dir: Vec3;
      if (f.axis === "X") dir = frame.x;
      else if (f.axis === "Y") dir = frame.y;
      else {
        // 스케치 안의 선을 축으로 사용
        const line = sk.curves.find((c) => c.id === f.axis);
        if (line?.kind !== "line") throw new Error("회전축으로 고른 선을 찾을 수 없습니다");
        const a = sk.points.find((p) => p.id === line.p1)!, b = sk.points.find((p) => p.id === line.p2)!;
        origin = planeTo3d(sk.plane, a.x, a.y);
        const end = planeTo3d(sk.plane, b.x, b.y);
        dir = [end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]];
      }
      const tool = sketchToDrawing(sk).sketchOnPlane(toPlane(sk.plane)).revolve(dir, { origin, angle }) as Shape3D;
      ctx.tools.set(f.id, { shape: tool.clone(), operation: f.operation });
      return combine(shape, tool, f.operation);
    }

    case "fillet": {
      if (!shape) throw new Error("필렛할 바디가 없습니다");
      const { radius } = resolveFeature(f, scope);
      if (radius <= 0) throw new Error("반지름은 0보다 커야 합니다");
      return shape.fillet(radius);
    }

    case "hole": {
      if (!shape) throw new Error("구멍을 뚫을 바디가 없습니다");
      const p = resolveFeature(f, scope);
      if (p.diameter <= 0) throw new Error("지름은 0보다 커야 합니다");
      // 바디를 위아래로 넉넉히 관통하는 원기둥으로 잘라냄 (전체 관통)
      const bb = shape.boundingBox;
      const tool = makeCylinder(p.diameter / 2, bb.depth + 2, [p.x, p.y, bb.bounds[0][2] - 1]);
      return shape.cut(tool);
    }

    case "sketchHole": {
      if (!shape) throw new Error("구멍을 뚫을 바디가 없습니다");
      const sk = sketchOf(ctx, f.sketchId);
      const pts = standalonePoints(sk);
      if (pts.length === 0) throw new Error("스케치에 구멍 위치(혼자 있는 점)가 없습니다. 스케치에서 '점' 도구로 찍어 주세요");
      const p = resolveFeature(f, scope);
      if (p.diameter <= 0) throw new Error("지름은 0보다 커야 합니다");
      const r = p.diameter / 2;
      const [lo, hi] = shape.boundingBox.bounds;
      const through = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2 + 1;
      const depth = p.depth > 0 ? p.depth : through;
      const R = p.headDiameter / 2;
      if (f.kind !== "simple" && R <= r) throw new Error("머리 지름은 구멍 지름보다 커야 합니다");
      if (f.kind === "counterbore" && (p.headDepth <= 0 || p.headDepth >= depth)) throw new Error("카운터보어 깊이는 0보다 크고 구멍 깊이보다 작아야 합니다");

      // 구멍 단면 (u = 반지름 방향, v = 축 방향, 위쪽이 +v). 면 위로 0.1 띄워서 시작해 깔끔하게 잘림
      const up = 0.1;
      const prof: [number, number][] =
        f.kind === "counterbore" ? [[0, up], [R, up], [R, -p.headDepth], [r, -p.headDepth], [r, -depth], [0, -depth]]
        : f.kind === "countersink" ? [[0, up], [R + up, up], [r, -(R - r)], [r, -depth], [0, -depth]] // 90° 접시머리
        : [[0, up], [r, up], [r, -depth], [0, -depth]];

      const frame = planeFrame(sk.plane);
      const axis: Vec3 = f.side === "in" ? frame.n : (frame.n.map((v) => -v) as Vec3); // 구멍은 -axis 쪽으로 파고듦
      let out = shape;
      for (const pt of pts) {
        const origin = planeTo3d(sk.plane, pt.x, pt.y);
        // 축을 포함하는 평면: 로컬 x = 스케치 x, 로컬 y = axis → 법선 = x × axis
        const plane = new Plane(origin, frame.x, cross(frame.x, axis));
        let pen = draw(prof[0]);
        for (const q of prof.slice(1)) pen = pen.lineTo(q);
        const tool = pen.close().sketchOnPlane(plane).revolve(axis, { origin }) as Shape3D;
        out = out.cut(tool);
      }
      return out;
    }

    case "shell": {
      if (!shape) throw new Error("쉘을 만들 바디가 없습니다");
      const { thickness } = resolveFeature(f, scope);
      if (thickness <= 0) throw new Error("두께는 0보다 커야 합니다");
      // 바디의 바깥쪽 끝 평면(예: +Z면 = 가장 위쪽 면)을 열어 둠
      const [lo, hi] = shape.boundingBox.bounds;
      const axis = "XYZ".indexOf(f.openFace[1]);
      const at = (f.openFace[0] === "+" ? hi : lo)[axis];
      const point: Vec3 = [0, 0, 0];
      point[axis] = at;
      const planeName = (["YZ", "XZ", "XY"] as const)[axis];
      const open = shape.faces.filter((face) => {
        if (face.geomType !== "PLANE") return false;
        const n = face.normalAt().toTuple();
        return Math.abs(Math.abs(n[axis]) - 1) < 1e-6 && Math.abs(face.center.toTuple()[axis] - at) < 1e-6;
      });
      if (open.length === 0) throw new Error(`${f.openFace} 방향 끝에 평평한 면이 없습니다`);
      // OCCT는 쉘이 안 될 때 예외 없이 원래 형상을 돌려주기도 함 → 부피로 확인해서 알려줌
      const hint = "두께를 필렛 반지름보다 작게 하거나, 떨어져 있는 바디가 없는지 확인하세요";
      const before = measureVolume(shape);
      let out: Shape3D;
      try { out = shape.shell(thickness, (finder) => finder.inPlane(planeName, point)); }
      catch { throw new Error(`쉘을 만들 수 없습니다. ${hint}`); }
      if (measureVolume(out) >= before * (1 - 1e-9)) throw new Error(`쉘이 적용되지 않았습니다. ${hint}`);
      return out;
    }

    case "pattern": {
      if (!shape) throw new Error("패턴을 적용할 바디가 없습니다");
      const src = sourceTool(ctx, f.sourceId);
      const p = resolveFeature(f, scope);
      const count = Math.round(p.count);
      if (count < 2 || count > 200) throw new Error("개수는 2~200 사이여야 합니다");
      const axisVec: Vec3 = f.axis === "X" ? [1, 0, 0] : f.axis === "Y" ? [0, 1, 0] : [0, 0, 1];
      // 원형: 360°면 한 바퀴를 count등분, 아니면 첫 개와 마지막 개 사이를 angle로
      const step = f.mode === "linear" ? p.distance
        : Math.abs(p.angle - 360) < 1e-9 ? 360 / count : p.angle / (count - 1);
      if (f.mode === "linear" && Math.abs(step) < 1e-9) throw new Error("간격은 0이 아니어야 합니다");
      let out = shape;
      for (let i = 1; i < count; i++) {
        const copy = src.shape.clone();
        const moved = f.mode === "linear"
          ? copy.translate(axisVec.map((v) => v * step * i) as Vec3)
          : copy.rotate(step * i, [0, 0, 0], axisVec);
        out = combine(out, moved, src.operation);
      }
      return out;
    }

    case "mirror": {
      if (!shape) throw new Error("미러를 적용할 바디가 없습니다");
      const src = sourceTool(ctx, f.sourceId);
      return combine(shape, src.shape.clone().mirror(f.plane, [0, 0, 0]), src.operation);
    }
  }
}

function sourceTool(ctx: Ctx, id: string): Tool {
  const t = ctx.tools.get(id);
  if (!t) throw new Error("원본 피처(돌출/회전)를 찾을 수 없거나 계산에 실패했습니다");
  return t;
}

// 메시 + 면 정보. 면 번호는 메시의 faceGroups 순서와 같다 (면 위 스케치용)
export interface FaceInfo { planar: boolean; origin: Vec3; normal: Vec3; area: number; kind: string; }
export interface MeshData {
  vertices: Float32Array; normals: Float32Array; triangles: Uint32Array; edges: Float32Array;
  faceGroups: { start: number; count: number }[];
  faces: FaceInfo[];
}

export function meshShape(shape: Shape3D): MeshData {
  const m = shape.mesh({ tolerance: 0.05, angularTolerance: 15 });
  const e = shape.meshEdges({ tolerance: 0.05, angularTolerance: 15 });
  const faces = shape.faces.map((f): FaceInfo => {
    const planar = f.geomType === "PLANE";
    return {
      planar,
      origin: f.center.toTuple() as Vec3,
      normal: planar ? (f.normalAt().toTuple() as Vec3) : [0, 0, 1],
      area: measureArea(f),
      kind: f.geomType,
    };
  });
  return {
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    edges: new Float32Array(e.lines),
    faceGroups: m.faceGroups.map((g) => ({ start: g.start, count: g.count })),
    faces,
  };
}
