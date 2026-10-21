import { drawRectangle, makeCylinder, measureVolume, type Shape3D } from "replicad";
import { sketchToDrawing } from "./profile";
import { activeFeatures, resolveFeature, resolveParameters, type CadDocument } from "@my-cad/core";

// 커널 어댑터: OCCT(replicad) 호출은 이 패키지 안에서만 한다 (core는 커널을 모름)
export interface FeatureError { featureId: string; message: string; }
export interface BuildResult { shape?: Shape3D; errors: FeatureError[]; volume?: number; }

export function buildDocument(doc: CadDocument): BuildResult {
  const errors: FeatureError[] = [];
  let scope;
  try { scope = resolveParameters(doc); }
  catch (e) { return { errors: [{ featureId: "parameters", message: (e as Error).message }] }; }

  let shape: Shape3D | undefined;
  for (const f of activeFeatures(doc)) {
    try {
      // 실패한 피처는 건너뛰고 직전 형상을 유지 (명세 F-10 예외 처리)
      shape = applyFeature(shape, f, scope, doc);
    } catch (e) {
      errors.push({ featureId: f.id, message: (e as Error).message || "커널 연산 실패" });
    }
  }
  return { shape, errors, volume: shape ? measureVolume(shape) : undefined };
}

function applyFeature(shape: Shape3D | undefined, f: CadDocument["features"][number], scope: Record<string, number>, doc: CadDocument): Shape3D | undefined {
  switch (f.type) {
    case "sketch":
      return shape; // 스케치는 형상을 바꾸지 않음
    case "extrude": {
      const sk = doc.features.find((x) => x.id === f.sketchId);
      if (sk?.type !== "sketch") throw new Error("돌출할 스케치를 찾을 수 없습니다");
      if (sk.suppressed) throw new Error("돌출할 스케치가 억제되어 있습니다");
      const { distance } = resolveFeature(f, scope);
      if (Math.abs(distance) < 1e-9) throw new Error("돌출 거리는 0이 아니어야 합니다");
      // 음수 거리는 반대 방향: 평면을 그만큼 옮긴 뒤 양수로 돌출
      const plane = sketchToDrawing(sk.sketch).sketchOnPlane(sk.sketch.plane, distance < 0 ? distance : 0);
      const tool = plane.extrude(Math.abs(distance)) as Shape3D;
      if (f.operation === "new" || !shape) {
        if (f.operation === "cut") throw new Error("잘라낼 바디가 없습니다");
        return f.operation === "new" && shape ? shape.fuse(tool) : tool; // M1은 단일 바디: 새 바디도 합쳐서 보관
      }
      return f.operation === "cut" ? shape.cut(tool) : shape.fuse(tool);
    }
    case "box": {
      const p = resolveFeature(f, scope);
      if (p.width <= 0 || p.depth <= 0 || p.height <= 0) throw new Error("치수는 0보다 커야 합니다");
      return drawRectangle(p.width, p.depth).sketchOnPlane("XY").extrude(p.height) as Shape3D;
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
  }
}

export interface MeshData { vertices: Float32Array; normals: Float32Array; triangles: Uint32Array; edges: Float32Array; }

export function meshShape(shape: Shape3D): MeshData {
  const m = shape.mesh({ tolerance: 0.05, angularTolerance: 15 });
  const e = shape.meshEdges({ tolerance: 0.05, angularTolerance: 15 });
  return {
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    edges: new Float32Array(e.lines),
  };
}
