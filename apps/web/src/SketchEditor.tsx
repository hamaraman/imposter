import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  removeSketchEntities, type Scope, type SketchData, type SkConstraint, type SkCurve, type SkPoint,
} from "@my-cad/core";
import { solveSketch, type SolveResult } from "@my-cad/sketch";

// 명세 F-03~F-06: 2D 스케치 편집기 (SVG). 그리기 → 구속 → 치수 → 솔버가 좌표를 바로잡음
export type Tool = "select" | "line" | "rect" | "circle" | "arc";

interface Props {
  sketch: SketchData;          // 솔버가 이미 푼 스케치
  result?: SolveResult;
  scope: Scope;
  onCommit: (sk: SketchData) => void;
  onExit: () => void;
}

const SNAP_PX = 9;
const AXIS_SNAP = Math.tan((3 * Math.PI) / 180); // 3° 이내면 자동 수평/수직

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function SketchEditor({ sketch, result, scope, onCommit, onExit }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ zoom: 8, cx: 20, cy: 15 }); // 화면 중앙의 월드 좌표
  const [tool, setTool] = useState<Tool>("line");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<string[]>([]); // 그리는 중인 점 ID들
  const [cursor, setCursor] = useState<[number, number]>();
  const [live, setLive] = useState<SketchData>();   // 드래그 중 미리보기
  const [dimInput, setDimInput] = useState<{ value: string; make: (v: string) => SkConstraint }>();
  const [message, setMessage] = useState<string>();
  const drag = useRef<{ id: string; moved: boolean; pan?: { x: number; y: number; cx: number; cy: number } }>();

  const sk = live ?? sketch;
  const pts = useMemo(() => new Map(sk.points.map((p) => [p.id, p])), [sk]);
  const conflicts = new Set(result?.conflicts ?? []);

  useEffect(() => {
    const el = svgRef.current!.parentElement!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 처음 열 때 스케치 전체가 보이게 맞춤
  useEffect(() => {
    if (sketch.points.length === 0) { setView({ zoom: 8, cx: 0, cy: 0 }); return; }
    const xs = sketch.points.map((p) => p.x), ys = sketch.points.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const span = Math.max(x1 - x0, y1 - y0, 10);
    setView({ zoom: Math.min(size.w, size.h) / (span * 1.6), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w > 0]);

  const toScreen = (x: number, y: number): [number, number] =>
    [(x - view.cx) * view.zoom + size.w / 2, -(y - view.cy) * view.zoom + size.h / 2];
  const toWorld = (sx: number, sy: number): [number, number] =>
    [(sx - size.w / 2) / view.zoom + view.cx, -(sy - size.h / 2) / view.zoom + view.cy];

  const eventWorld = (e: React.PointerEvent | React.WheelEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return toWorld(e.clientX - r.left, e.clientY - r.top);
  };

  // 화면 기준 가까운 점 / 곡선 찾기
  const hitPoint = (w: [number, number], exclude?: string) => {
    let best: SkPoint | undefined, bd = SNAP_PX / view.zoom;
    for (const p of sk.points) {
      if (p.id === exclude) continue;
      const d = Math.hypot(p.x - w[0], p.y - w[1]);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const hitCurve = (w: [number, number]) => {
    let best: SkCurve | undefined, bd = 6 / view.zoom;
    for (const c of sk.curves) {
      const d = curveDistance(c, w, pts);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  const commit = useCallback((next: SketchData) => { setLive(undefined); onCommit(next); }, [onCommit]);

  // 점을 새로 만들거나, 근처의 기존 점을 재사용 (끝점 자동 연결)
  const pointAt = (w: [number, number], points: SkPoint[]): [string, SkPoint[]] => {
    const hit = hitPoint(w);
    if (hit) return [hit.id, points];
    const p = { id: uid("p"), x: w[0], y: w[1] };
    return [p.id, [...points, p]];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const w = eventWorld(e);
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      drag.current = { id: "", moved: false, pan: { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy } };
      return;
    }
    if (e.button === 2) { setDraft([]); return; }
    setMessage(undefined);

    if (tool === "select") {
      const p = hitPoint(w);
      const c = p ? undefined : hitCurve(w);
      const id = p?.id ?? c?.id;
      if (!id) { if (!e.shiftKey) setSelected(new Set()); return; }
      setSelected((s) => {
        const n = new Set(e.shiftKey ? s : []);
        if (e.shiftKey && s.has(id)) n.delete(id); else n.add(id);
        return n;
      });
      if (p) drag.current = { id: p.id, moved: false };
      return;
    }

    let points = [...sk.points];
    const curves = [...sk.curves];
    const constraints = [...sk.constraints];
    let id: string;
    [id, points] = pointAt(w, points);

    if (tool === "line") {
      if (draft.length === 0) { setDraft([id]); commitDraftPoints(points); return; }
      const prev = draft[draft.length - 1];
      if (prev === id) return;
      const l = { id: uid("l"), kind: "line" as const, p1: prev, p2: id };
      curves.push(l);
      autoAxis(l, points, constraints);
      // 시작점을 다시 누르면 닫고 끝냄
      const closed = id === draft[0];
      setDraft(closed ? [] : [...draft, id]);
      commit({ ...sk, points, curves, constraints });
      return;
    }

    if (tool === "rect") {
      if (draft.length === 0) { setDraft([id]); commitDraftPoints(points); return; }
      const a = points.find((p) => p.id === draft[0])!;
      const b = points.find((p) => p.id === id)!;
      if (Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6) { setMessage("사각형의 크기가 0입니다"); return; }
      const c2 = { id: uid("p"), x: b.x, y: a.y }, c4 = { id: uid("p"), x: a.x, y: b.y };
      points.push(c2, c4);
      const ls = [[a.id, c2.id], [c2.id, b.id], [b.id, c4.id], [c4.id, a.id]].map(([p1, p2]) => ({ id: uid("l"), kind: "line" as const, p1, p2 }));
      curves.push(...ls);
      constraints.push(
        { id: uid("k"), kind: "horizontal", line: ls[0].id }, { id: uid("k"), kind: "vertical", line: ls[1].id },
        { id: uid("k"), kind: "horizontal", line: ls[2].id }, { id: uid("k"), kind: "vertical", line: ls[3].id },
      );
      setDraft([]);
      commit({ ...sk, points, curves, constraints });
      return;
    }

    if (tool === "circle") {
      if (draft.length === 0) { setDraft([id]); commitDraftPoints(points); return; }
      // 반지름 클릭은 점을 만들지 않음 (원 위에 떠도는 점이 남지 않게)
      points = [...sk.points];
      const c = points.find((p) => p.id === draft[0])!;
      const r = Math.hypot(w[0] - c.x, w[1] - c.y);
      if (r < 1e-6) return;
      curves.push({ id: uid("c"), kind: "circle", c: c.id, r });
      setDraft([]);
      commit({ ...sk, points, curves, constraints });
      return;
    }

    if (tool === "arc") {
      // 중심 → 시작점 → 끝점 (반시계 방향)
      if (draft.length < 2) { setDraft([...draft, id]); commitDraftPoints(points); return; }
      const c = points.find((p) => p.id === draft[0])!, s = points.find((p) => p.id === draft[1])!;
      const r = Math.hypot(s.x - c.x, s.y - c.y);
      // 끝점은 반지름 위에 오도록 투영 (이미 있는 점을 고른 경우 그대로 두고 솔버가 맞춤)
      const existing = sk.points.some((p) => p.id === id);
      if (!existing) {
        const t = Math.atan2(w[1] - c.y, w[0] - c.x);
        points = points.map((p) => (p.id === id ? { ...p, x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) } : p));
      }
      curves.push({ id: uid("a"), kind: "arc", c: c.id, s: s.id, e: id, r });
      setDraft([]);
      commit({ ...sk, points, curves, constraints });
    }
  };

  // 그리는 중에 만든 점은 바로 문서에 넣어 둔다 (곡선이 안 붙으면 나중에 정리됨)
  const commitDraftPoints = (points: SkPoint[]) => {
    if (points.length !== sk.points.length) setLive({ ...sk, points });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = eventWorld(e);
    setCursor(hitPoint(w) ? [hitPoint(w)!.x, hitPoint(w)!.y] : w);
    const d = drag.current;
    if (!d) return;
    if (d.pan) {
      setView((v) => ({ ...v, cx: d.pan!.cx - (e.clientX - d.pan!.x) / v.zoom, cy: d.pan!.cy + (e.clientY - d.pan!.y) / v.zoom }));
      return;
    }
    d.moved = true;
    // 끌고 있는 점을 옮긴 뒤 바로 솔버로 풀어서 구속을 유지한 채 미리보기
    const moved = { ...sketch, points: sketch.points.map((p) => (p.id === d.id && !p.fixed ? { ...p, x: w[0], y: w[1] } : p)) };
    const r = solveSketch(moved, scope);
    setLive(r.status === "over" ? moved : r.sketch);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (d && !d.pan && d.moved && live) commit(live);
  };

  const onWheel = (e: React.WheelEvent) => {
    const w = eventWorld(e);
    const f = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const zoom = Math.min(Math.max(v.zoom * f, 0.05), 500);
      // 커서 위치를 기준으로 확대
      return { zoom, cx: w[0] - (w[0] - v.cx) * (v.zoom / zoom), cy: w[1] - (w[1] - v.cy) * (v.zoom / zoom) };
    });
  };

  // 키보드: Esc 그리기 취소, Delete 선택 삭제, 단축키로 도구 전환
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "Escape") { if (draft.length) setDraft([]); else setSelected(new Set()); setLive(undefined); }
      if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
        commit(removeSketchEntities(sketch, selected));
        setSelected(new Set());
      }
      const keys: Record<string, Tool> = { s: "select", l: "line", r: "rect", c: "circle", a: "arc" };
      if (!e.ctrlKey && !e.metaKey && keys[e.key]) { setTool(keys[e.key]); setDraft([]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, selected, sketch, commit]);

  // ── 구속조건 ─────────────────────────────────────────────
  const sel = [...selected];
  const selPoints = sel.filter((id) => pts.has(id));
  const selCurves = sel.map((id) => sk.curves.find((c) => c.id === id)).filter(Boolean) as SkCurve[];
  const selLines = selCurves.filter((c) => c.kind === "line");
  const selRound = selCurves.filter((c) => c.kind !== "line");
  const only = (n: number) => sel.length === n;

  const addConstraints = (ks: SkConstraint[]) => {
    const r = solveSketch({ ...sketch, constraints: [...sketch.constraints, ...ks] }, scope);
    if (r.status === "over") { setMessage("이 구속을 추가하면 다른 구속과 충돌합니다"); return; }
    commit({ ...sketch, constraints: [...sketch.constraints, ...ks] });
    setSelected(new Set());
  };

  const actions: { label: string; title: string; enabled: boolean; run: () => void }[] = [
    { label: "일치", title: "점 2개", enabled: only(2) && selPoints.length === 2,
      run: () => addConstraints([{ id: uid("k"), kind: "coincident", a: selPoints[0], b: selPoints[1] }]) },
    { label: "수평", title: "선 1개 이상", enabled: sel.length > 0 && selLines.length === sel.length,
      run: () => addConstraints(selLines.map((l) => ({ id: uid("k"), kind: "horizontal", line: l.id }))) },
    { label: "수직", title: "선 1개 이상", enabled: sel.length > 0 && selLines.length === sel.length,
      run: () => addConstraints(selLines.map((l) => ({ id: uid("k"), kind: "vertical", line: l.id }))) },
    { label: "평행", title: "선 2개", enabled: only(2) && selLines.length === 2,
      run: () => addConstraints([{ id: uid("k"), kind: "parallel", a: selLines[0].id, b: selLines[1].id }]) },
    { label: "직교", title: "선 2개", enabled: only(2) && selLines.length === 2,
      run: () => addConstraints([{ id: uid("k"), kind: "perpendicular", a: selLines[0].id, b: selLines[1].id }]) },
    { label: "동일", title: "선 2개 또는 원/호 2개", enabled: only(2) && (selLines.length === 2 || selRound.length === 2),
      run: () => addConstraints([{ id: uid("k"), kind: "equal", a: selCurves[0].id, b: selCurves[1].id }]) },
    { label: "접선", title: "선 1개 + 원/호 1개", enabled: only(2) && selLines.length === 1 && selRound.length === 1,
      run: () => addConstraints([{ id: uid("k"), kind: "tangent", line: selLines[0].id, curve: selRound[0].id }]) },
    { label: "점→선", title: "점 1개 + 선 1개", enabled: only(2) && selPoints.length === 1 && selLines.length === 1,
      run: () => addConstraints([{ id: uid("k"), kind: "pointOnLine", point: selPoints[0], line: selLines[0].id }]) },
    { label: "고정", title: "점 1개 이상 (다시 누르면 해제)", enabled: sel.length > 0 && selPoints.length === sel.length,
      run: () => { commit({ ...sketch, points: sketch.points.map((p) => (selected.has(p.id) ? { ...p, fixed: !p.fixed } : p)) }); } },
    { label: "보조선", title: "선택한 곡선을 보조선으로 (프로필에서 빠짐, 회전축 등에 사용) · 다시 누르면 해제",
      enabled: selCurves.length > 0 && selCurves.length === sel.length,
      run: () => { commit({ ...sketch, curves: sketch.curves.map((c) => (selected.has(c.id) ? { ...c, construction: !c.construction } : c)) }); } },
    { label: "치수", title: "선 1개(길이) · 점 2개(거리) · 원/호 1개(반지름)",
      enabled: (only(1) && selCurves.length === 1) || (only(2) && selPoints.length === 2),
      run: () => {
        if (selPoints.length === 2) {
          const [a, b] = [pts.get(selPoints[0])!, pts.get(selPoints[1])!];
          setDimInput({ value: fmt(Math.hypot(a.x - b.x, a.y - b.y)), make: (v) => ({ id: uid("k"), kind: "distance", a: a.id, b: b.id, value: v }) });
        } else if (selLines.length === 1) {
          const l = selLines[0] as Extract<SkCurve, { kind: "line" }>;
          const [a, b] = [pts.get(l.p1)!, pts.get(l.p2)!];
          setDimInput({ value: fmt(Math.hypot(a.x - b.x, a.y - b.y)), make: (v) => ({ id: uid("k"), kind: "length", line: l.id, value: v }) });
        } else {
          const c = selRound[0];
          setDimInput({ value: fmt((c as { r: number }).r), make: (v) => ({ id: uid("k"), kind: "radius", curve: c.id, value: v }) });
        }
      } },
  ];

  // ── 그리기 ──────────────────────────────────────────────
  const statusColor = result?.status === "full" ? "#111827" : result?.status === "over" ? "#dc2626" : "#2563eb";
  const conflictRefs = new Set(sk.constraints.filter((k) => conflicts.has(k.id)).flatMap((k) => Object.values(k).filter((v) => typeof v === "string")));
  const strokeOf = (id: string) => (selected.has(id) ? "#f59e0b" : conflictRefs.has(id) ? "#dc2626" : statusColor);

  const preview = (() => {
    if (!cursor || draft.length === 0) return null;
    const a = pts.get(draft[draft.length - 1]) ?? live?.points.find((p) => p.id === draft[draft.length - 1]);
    const first = pts.get(draft[0]);
    if (!a || !first) return null;
    const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(cursor[0], cursor[1]);
    if (tool === "line") return <line x1={ax} y1={ay} x2={bx} y2={by} className="pv" />;
    if (tool === "rect") {
      const [fx, fy] = toScreen(first.x, first.y);
      return <rect x={Math.min(fx, bx)} y={Math.min(fy, by)} width={Math.abs(bx - fx)} height={Math.abs(by - fy)} className="pv" />;
    }
    if (tool === "circle" || (tool === "arc" && draft.length === 1)) {
      const [fx, fy] = toScreen(first.x, first.y);
      return <circle cx={fx} cy={fy} r={Math.hypot(bx - fx, by - fy)} className="pv" />;
    }
    return null;
  })();

  const grid = useMemo(() => {
    const step = niceStep(40 / view.zoom);
    const [x0, y1] = toWorld(0, 0), [x1, y0] = toWorld(size.w, size.h);
    const lines: JSX.Element[] = [];
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      const [sx] = toScreen(x, 0);
      lines.push(<line key={`x${x}`} x1={sx} y1={0} x2={sx} y2={size.h} className={Math.abs(x) < 1e-9 ? "axis" : "grid"} />);
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const [, sy] = toScreen(0, y);
      lines.push(<line key={`y${y}`} x1={0} y1={sy} x2={size.w} y2={sy} className={Math.abs(y) < 1e-9 ? "axis" : "grid"} />);
    }
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, size]);

  return (
    <div className="sketch-editor">
      <div className="sk-tools">
        {(["select", "line", "rect", "circle", "arc"] as Tool[]).map((t) => (
          <button key={t} className={tool === t ? "on" : ""} onClick={() => { setTool(t); setDraft([]); }}>
            {{ select: "선택 (S)", line: "선 (L)", rect: "사각형 (R)", circle: "원 (C)", arc: "호 (A)" }[t]}
          </button>
        ))}
        <span className="sep" />
        {actions.map((a) => (
          <button key={a.label} disabled={!a.enabled} title={a.title} onClick={a.run}>{a.label}</button>
        ))}
        <span className="sep" />
        <button className="primary" onClick={onExit}>✓ 스케치 종료</button>
      </div>

      <svg ref={svgRef} width={size.w} height={size.h}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}
        style={{ cursor: tool === "select" ? "default" : "crosshair" }}>
        {grid}
        {sk.curves.map((c) => <CurveShape key={c.id} c={c} pts={pts} toScreen={toScreen} stroke={strokeOf(c.id)} />)}
        {sk.constraints.map((k) => <DimLabel key={k.id} k={k} sk={sk} pts={pts} toScreen={toScreen} scope={scope} bad={conflicts.has(k.id)} />)}
        {sk.points.map((p) => {
          const [x, y] = toScreen(p.x, p.y);
          return p.fixed
            ? <rect key={p.id} x={x - 4} y={y - 4} width={8} height={8} fill={selected.has(p.id) ? "#f59e0b" : "#111827"} />
            : <circle key={p.id} cx={x} cy={y} r={selected.has(p.id) ? 5 : 3.5} fill={strokeOf(p.id)} />;
        })}
        {preview}
      </svg>

      <div className="sk-status">
        <span style={{ color: statusColor }}>
          ● {result?.status === "full" ? "완전 구속" : result?.status === "over" ? "충돌" : `자유도 ${Math.max(result?.dof ?? 0, 0)} 남음`}
        </span>
        {cursor && <span>x {fmt(cursor[0])} · y {fmt(cursor[1])}</span>}
        <span className="hint">{message ?? result?.error ?? hint(tool, draft.length)}</span>
      </div>

      {dimInput && (
        <form className="dim-input" onSubmit={(e) => {
          e.preventDefault();
          if (dimInput.value.trim()) addConstraints([dimInput.make(dimInput.value.trim())]);
          setDimInput(undefined);
        }}>
          <label>치수 값 (수식 가능)</label>
          <input autoFocus value={dimInput.value} onChange={(e) => setDimInput({ ...dimInput, value: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && setDimInput(undefined)} />
          <button type="submit">적용</button>
        </form>
      )}
    </div>
  );
}

function autoAxis(l: { id: string; p1: string; p2: string }, points: SkPoint[], constraints: SkConstraint[]) {
  const a = points.find((p) => p.id === l.p1)!, b = points.find((p) => p.id === l.p2)!;
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if (dy <= dx * AXIS_SNAP) constraints.push({ id: uid("k"), kind: "horizontal", line: l.id });
  else if (dx <= dy * AXIS_SNAP) constraints.push({ id: uid("k"), kind: "vertical", line: l.id });
}

function CurveShape({ c, pts, toScreen, stroke }: { c: SkCurve; pts: Map<string, SkPoint>; toScreen: (x: number, y: number) => [number, number]; stroke: string }) {
  const dash = c.construction ? "6 4" : undefined;
  if (c.kind === "line") {
    const a = pts.get(c.p1), b = pts.get(c.p2);
    if (!a || !b) return null;
    const [x1, y1] = toScreen(a.x, a.y), [x2, y2] = toScreen(b.x, b.y);
    return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2} strokeDasharray={dash} />;
  }
  const cc = pts.get(c.c);
  if (!cc) return null;
  const [cx, cy] = toScreen(cc.x, cc.y);
  const [ex] = toScreen(cc.x + c.r, cc.y);
  const r = Math.abs(ex - cx);
  if (c.kind === "circle") return <circle cx={cx} cy={cy} r={r} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray={dash} />;
  const s = pts.get(c.s), e = pts.get(c.e);
  if (!s || !e) return null;
  const [sx, sy] = toScreen(s.x, s.y), [ex2, ey2] = toScreen(e.x, e.y);
  let a0 = Math.atan2(s.y - cc.y, s.x - cc.x), a1 = Math.atan2(e.y - cc.y, e.x - cc.x);
  if (a1 <= a0) a1 += 2 * Math.PI;
  // 화면은 y가 뒤집혀 있으므로 반시계 호 = SVG sweep 0
  return <path d={`M ${sx} ${sy} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${ex2} ${ey2}`} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray={dash} />;
}

function DimLabel({ k, sk, pts, toScreen, scope, bad }: {
  k: SkConstraint; sk: SketchData; pts: Map<string, SkPoint>; toScreen: (x: number, y: number) => [number, number]; scope: Scope; bad: boolean;
}) {
  let at: [number, number] | undefined, text = "";
  const label = (v: string, prefix = "") => {
    const n = Number(v);
    return prefix + (Number.isFinite(n) ? fmt(n) : v);
  };
  if (k.kind === "length") {
    const l = sk.curves.find((c) => c.id === k.line);
    if (l?.kind === "line") { const a = pts.get(l.p1)!, b = pts.get(l.p2)!; at = [(a.x + b.x) / 2, (a.y + b.y) / 2]; text = label(k.value); }
  } else if (k.kind === "distance") {
    const a = pts.get(k.a), b = pts.get(k.b);
    if (a && b) { at = [(a.x + b.x) / 2, (a.y + b.y) / 2]; text = label(k.value); }
  } else if (k.kind === "radius") {
    const c = sk.curves.find((x) => x.id === k.curve);
    if (c && c.kind !== "line") { const cc = pts.get(c.c)!; at = [cc.x + c.r * 0.7, cc.y + c.r * 0.7]; text = label(k.value, "R"); }
  } else if (k.kind === "coordinate") {
    const p = pts.get(k.point);
    if (p) { at = [p.x, p.y]; text = `${k.axis}=${label(k.value)}`; }
  }
  void scope;
  if (!at) return null;
  const [x, y] = toScreen(at[0], at[1]);
  const dy = k.kind === "coordinate" && k.axis === "y" ? 10 : -6; // x/y 좌표 라벨이 겹치지 않게
  return <text x={x + 6} y={y + dy} className={bad ? "dim bad" : "dim"}>{text}</text>;
}

function curveDistance(c: SkCurve, [x, y]: [number, number], pts: Map<string, SkPoint>): number {
  if (c.kind === "line") {
    const a = pts.get(c.p1), b = pts.get(c.p2);
    if (!a || !b) return Infinity;
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
  }
  const cc = pts.get(c.c);
  if (!cc) return Infinity;
  const d = Math.abs(Math.hypot(x - cc.x, y - cc.y) - c.r);
  if (c.kind === "circle") return d;
  const s = pts.get(c.s)!, e = pts.get(c.e)!;
  let a0 = Math.atan2(s.y - cc.y, s.x - cc.x), a1 = Math.atan2(e.y - cc.y, e.x - cc.x), t = Math.atan2(y - cc.y, x - cc.x);
  if (a1 <= a0) a1 += 2 * Math.PI;
  if (t < a0) t += 2 * Math.PI;
  return t <= a1 ? d : Infinity;
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

function hint(tool: Tool, n: number) {
  switch (tool) {
    case "select": return "클릭: 선택 · Shift+클릭: 여러 개 · 점 드래그: 이동 · Delete: 삭제 · 휠: 확대 · Alt+드래그: 이동";
    case "line": return n ? "다음 점 클릭 · 시작점을 누르면 닫힘 · 우클릭/Esc: 끝내기" : "시작점 클릭 (기존 점 근처를 누르면 이어짐)";
    case "rect": return n ? "반대쪽 모서리 클릭" : "첫 모서리 클릭";
    case "circle": return n ? "반지름 위치 클릭" : "중심 클릭";
    case "arc": return ["중심 클릭", "시작점 클릭", "끝점 클릭 (반시계 방향)"][n] ?? "";
  }
}
