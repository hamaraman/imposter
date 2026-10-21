import { draw, drawCircle, type Drawing } from "replicad";
import type { SketchData, SkCurve } from "@my-cad/core";

// 스케치의 선/호/원에서 닫힌 루프를 찾아 하나의 2D 영역(Drawing)으로 만든다.
// 루프 안에 있는 루프는 구멍으로, 구멍 안의 루프는 다시 섬으로 처리 (짝수/홀수 깊이 규칙)
const TOL = 1e-6;

interface Edge { curve: SkCurve; a: number; b: number; }  // a, b = 합쳐진 꼭짓점 번호
interface Loop { drawing: Drawing; poly: [number, number][]; area: number; }

export function sketchToDrawing(sk: SketchData): Drawing {
  const loops = findLoops(sk);
  if (loops.length === 0) throw new Error("닫힌 프로필이 없습니다. 선의 끝점을 서로 이어서 닫아 주세요");
  loops.sort((x, y) => Math.abs(y.area) - Math.abs(x.area));

  let result: Drawing | undefined;
  for (let i = 0; i < loops.length; i++) {
    const depth = loops.slice(0, i).filter((o) => pointInPolygon(loops[i].poly[0], o.poly)).length;
    if (!result) { result = loops[i].drawing; continue; }
    result = depth % 2 === 0 ? result.fuse(loops[i].drawing) : result.cut(loops[i].drawing);
  }
  return result!;
}

export function findLoops(sk: SketchData): Loop[] {
  const pts = new Map(sk.points.map((p) => [p.id, p]));
  const P = (id: string) => {
    const p = pts.get(id);
    if (!p) throw new Error(`스케치 점을 찾을 수 없음: ${id}`);
    return [p.x, p.y] as [number, number];
  };
  const loops: Loop[] = [];
  const curves = sk.curves.filter((c) => !c.construction);

  // 원은 그 자체로 닫힌 루프
  for (const c of curves) {
    if (c.kind !== "circle") continue;
    const [cx, cy] = P(c.c);
    const poly = Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * 2 * Math.PI;
      return [cx + c.r * Math.cos(t), cy + c.r * Math.sin(t)] as [number, number];
    });
    loops.push({ drawing: drawCircle(c.r).translate(cx, cy), poly, area: Math.PI * c.r * c.r });
  }

  // 선과 호: 같은 좌표의 끝점을 하나의 꼭짓점으로 합친 뒤 그래프를 따라 순환을 찾는다
  const verts: [number, number][] = [];
  const vertexOf = (xy: [number, number]) => {
    let i = verts.findIndex((v) => Math.hypot(v[0] - xy[0], v[1] - xy[1]) < TOL * 1000);
    if (i < 0) { verts.push(xy); i = verts.length - 1; }
    return i;
  };
  const edges: Edge[] = [];
  for (const c of curves) {
    if (c.kind === "line") edges.push({ curve: c, a: vertexOf(P(c.p1)), b: vertexOf(P(c.p2)) });
    if (c.kind === "arc") edges.push({ curve: c, a: vertexOf(P(c.s)), b: vertexOf(P(c.e)) });
  }

  const used = new Set<number>();
  for (let start = 0; start < edges.length; start++) {
    if (used.has(start)) continue;
    // 시작 간선에서 출발해 아직 안 쓴 간선을 따라가며 출발점으로 돌아오는지 본다
    const chain: { e: Edge; forward: boolean }[] = [{ e: edges[start], forward: true }];
    const taken = new Set([start]);
    let cur = edges[start].b;
    while (cur !== edges[start].a) {
      const next = edges.findIndex((e, i) => !taken.has(i) && !used.has(i) && (e.a === cur || e.b === cur));
      if (next < 0) break;
      const e = edges[next];
      taken.add(next);
      chain.push({ e, forward: e.a === cur });
      cur = e.a === cur ? e.b : e.a;
    }
    if (cur !== edges[start].a) continue; // 열린 체인은 프로필이 아님
    taken.forEach((i) => used.add(i));
    loops.push(chainToLoop(chain, verts, P));
  }
  return loops;
}

function chainToLoop(chain: { e: Edge; forward: boolean }[], verts: [number, number][], P: (id: string) => [number, number]): Loop {
  const first = chain[0];
  const start = verts[first.forward ? first.e.a : first.e.b];
  let pen = draw(start);
  const poly: [number, number][] = [start];
  for (const { e, forward } of chain) {
    const end = verts[forward ? e.b : e.a];
    if (e.curve.kind === "line") {
      pen = pen.lineTo(end);
    } else if (e.curve.kind === "arc") {
      // 호는 항상 s → e 반시계 방향. 중간점을 구해 세 점 호로 그린다 (방향과 무관하게 같은 곡선)
      const [cx, cy] = P(e.curve.c);
      const [sx, sy] = P(e.curve.s), [ex, ey] = P(e.curve.e);
      let a0 = Math.atan2(sy - cy, sx - cx), a1 = Math.atan2(ey - cy, ex - cx);
      if (a1 <= a0) a1 += 2 * Math.PI;
      const r = Math.hypot(sx - cx, sy - cy);
      const am = (a0 + a1) / 2;
      const mid: [number, number] = [cx + r * Math.cos(am), cy + r * Math.sin(am)];
      pen = pen.threePointsArcTo(end, mid);
      for (let k = 1; k < 8; k++) {
        const t = forward ? a0 + ((a1 - a0) * k) / 8 : a1 - ((a1 - a0) * k) / 8;
        poly.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
      }
    }
    poly.push(end);
  }
  poly.pop(); // 마지막 점 = 시작점
  return { drawing: pen.close(), poly, area: polygonArea(poly) };
}

function polygonArea(poly: [number, number][]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInPolygon([x, y]: [number, number], poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
