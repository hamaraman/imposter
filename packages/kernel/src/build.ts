import { drawRectangle, makeCylinder, measureVolume, Plane, type Shape3D } from "replicad";
import {
  activeFeatures, planeFrame, planeTo3d, resolveFeature, resolveParameters,
  type CadDocument, type ExtrudeOperation, type Feature, type SketchPlane, type Vec3,
} from "@my-cad/core";
import { sketchToDrawing } from "./profile";

// 커널 어댑터: OCCT(replicad) 호출은 이 패키지 안에서만 한다 (core는 커널을 모름)
export interface FeatureError { featureId: string; message: string; }
export interface BuildResult { shape?: Shape3D; errors: FeatureError[]; volume?: number; }

// 돌출/회전이 만든 "도구" 형상을 기억해 두었다가 패턴·미러에서 다시 쓴다
interface Tool { shape: Shape3D; operation: ExtrudeOperation; }
interface Ctx { shape?: Shape3D; tools: Map<string, Tool>; doc: CadDocument; scope: Record<string, number>; }

export function buildDocument(doc: CadDocument): BuildResult {
  const errors: FeatureError[] = [];
  let scope;
  try { scope = resolveParameters(doc); }
  catch (e) { return { errors: [{ featureId: "parameters", message: (e as Error).message }] }; }

  const ctx: Ctx = { tools: new Map(), doc, scope };
  for (const f of activeFeatures(doc)) {
    try {
      // 실패한 피처는 건너뛰고 직전 형상을 유지 (명세 F-10 예외 처리)
      ctx.shape = applyFeature(f, ctx);
    } catch (e) {
      errors.push({ featureId: f.id, message: kernelMessage(e) });
    }
  }
  return { shape: ctx.shape, errors, volume: ctx.shape ? measureVolume(ctx.shape) : undefined };
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

function sketchOf(ctx: Ctx, sketchId: string) {
  const sk = ctx.doc.features.find((x) => x.id === sketchId);
  if (sk?.type !== "sketch") throw new Error("사용할 스케치를 찾을 수 없습니다");
  if (sk.suppressed) throw new Error("사용할 스케치가 억제되어 있습니다");
  return sk.sketch;
}

function applyFeature(f: Feature, ctx: Ctx): Shape3D | undefined {
  const { shape, scope } = ctx;
  switch (f.type) {
    case "sketch":
      return shape; // 스케치는 형상을 바꾸지 않음

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
export interface FaceInfo { planar: boolean; origin: Vec3; normal: Vec3; }
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
