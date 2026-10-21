import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  History, newDocument, serialize, deserialize, setParameter, setFeatureParam, toggleSuppress, setRollback,
  addSketch, updateSketch, addExtrude, addRevolve, addShell, addPattern, addMirror, addSketchHole, setSketchFollow,
  setFeatureField, deleteFeature,
  resolveParameters, planeFromNormal, planeLabel,
  type CadDocument, type Command, type ExtrudeOperation, type Feature, type SketchPlane, type Scope,
} from "@my-cad/core";
import { solveDocument, type SolveResult } from "@my-cad/sketch";
import { initBrowserSolver } from "@my-cad/sketch/src/browser";
import { KernelClient, type BuildReply } from "@my-cad/kernel/src/client";
import type { MassProps } from "@my-cad/kernel/src/build";
import { Viewport } from "./Viewport";
import { SketchEditor } from "./SketchEditor";
import { openTextFile, saveFile } from "./platform";

const FEATURE_LABEL: Record<Feature["type"], string> = {
  box: "박스", fillet: "필렛", hole: "구멍", sketch: "스케치", extrude: "돌출",
  revolve: "회전", shell: "쉘", pattern: "패턴", mirror: "미러", sketchHole: "구멍",
};
// 재료 밀도 (g/cm³). 질량 = 부피(mm³) × 밀도 / 1000 → g
const MATERIALS: [string, number][] = [
  ["PLA", 1.24], ["PETG", 1.27], ["ABS", 1.04], ["나일론 (PA12)", 1.01], ["알루미늄 6061", 2.7], ["강철", 7.85], ["스테인리스 304", 8.0], ["황동", 8.5],
];
const PARAM_LABEL: Record<string, string> = {
  distance: "거리 (음수: 반대 방향)", angle: "각도 (°)", thickness: "두께", count: "개수", radius: "반지름",
  diameter: "지름", width: "폭", depth: "깊이 (0 = 관통)", height: "높이", headDiameter: "머리 지름", headDepth: "머리 깊이",
};
const OPERATION_LABEL: Record<ExtrudeOperation, string> = { new: "새 바디", join: "결합", cut: "잘라내기" };

export function App() {
  const history = useMemo(() => new History(newDocument()), []);
  const kernel = useMemo(() => new KernelClient(), []);
  const [doc, setDoc] = useState<CadDocument>(history.current);
  const [solverReady, setSolverReady] = useState(false);
  const [result, setResult] = useState<BuildReply>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("커널 불러오는 중…");
  const [selectedId, setSelectedId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [picking, setPicking] = useState(false); // 면 위 스케치: 면 고르는 중
  const [measuring, setMeasuring] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    initBrowserSolver().then(() => setSolverReady(true)).catch((e) => setStatus(`솔버 오류: ${e.message}`));
  }, []);

  // 1단계: 모든 스케치를 현재 파라미터로 다시 풂 (메인 스레드, 수 ms)
  const solved = useMemo(() => (solverReady ? solveDocument(doc) : undefined), [doc, solverReady]);
  // 화면 표시용: 커널이 면을 따라 옮긴 스케치 평면을 반영
  const shown = useMemo(() => {
    if (!solved || !result?.planes || Object.keys(result.planes).length === 0) return solved?.doc;
    return { ...solved.doc, features: solved.doc.features.map((f) =>
      f.type === "sketch" && result.planes[f.id] ? { ...f, sketch: { ...f.sketch, plane: result.planes[f.id] } } : f) };
  }, [solved, result]);
  const scope = useMemo<Scope>(() => { try { return resolveParameters(doc); } catch { return {}; } }, [doc]);

  // 2단계: 푼 문서를 커널 워커로 보내 3D 형상 계산. 오래된 응답은 버린다
  useEffect(() => {
    if (!solved) return;
    const ticket = ++latest.current;
    setBusy(true);
    const t0 = performance.now();
    kernel.build(solved.doc)
      .then((r) => {
        if (ticket !== latest.current) return;
        setResult(r);
        setStatus(r.errors.length ? `오류 ${r.errors.length}개` : `재계산 ${Math.round(performance.now() - t0)}ms`);
      })
      .catch((e) => ticket === latest.current && setStatus(`커널 오류: ${e.message}`))
      .finally(() => ticket === latest.current && setBusy(false));
  }, [solved, kernel]);

  const run = useCallback((cmd: Command) => {
    try { setDoc(history.run(cmd)); } catch (e) { setStatus((e as Error).message); }
  }, [history]);
  const undo = useCallback(() => setDoc(history.undo()), [history]);
  const redo = useCallback(() => setDoc(history.redo()), [history]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Undo로 편집 중인 스케치가 사라지면 편집 모드를 빠져나옴
  useEffect(() => {
    if (editingId && !doc.features.some((f) => f.id === editingId)) setEditingId(undefined);
    if (selectedId && !doc.features.some((f) => f.id === selectedId)) setSelectedId(undefined);
  }, [doc, editingId, selectedId]);

  const exportAs = async (format: "stl" | "step" | "3mf") => {
    if (!solved) return;
    try {
      const data = await kernel.export(solved.doc, format);
      if (await saveFile(`model.${format}`, new Uint8Array(data), format)) setStatus(`${format.toUpperCase()} 저장 완료`);
    } catch (e) { setStatus(`내보내기 실패: ${(e as Error).message}`); }
  };
  const saveDoc = async () => {
    try { if (await saveFile("design.mycad", serialize(solved?.doc ?? doc), "mycad")) setStatus("저장 완료"); }
    catch (e) { setStatus(`저장 실패: ${(e as Error).message}`); }
  };
  const openDoc = async () => {
    try {
      const text = await openTextFile("mycad");
      if (text) {
        const d = deserialize(text);
        history.current = d; setDoc(d); setEditingId(undefined); setSelectedId(undefined);
        setStatus("열기 완료");
      }
    } catch (e) { setStatus(`열기 실패: ${(e as Error).message}`); }
  };

  const newSketch = (plane: SketchPlane) => run(addSketch(plane, (id) => { setEditingId(id); setSelectedId(id); }));
  // Esc: 측정 끄기 → 선택 해제 (면 고르기·스케치 편집 중에는 그쪽에서 처리)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || editingId || picking || (e.target as HTMLElement).tagName === "INPUT") return;
      if (measuring) setMeasuring(false); else setSelectedId(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId, picking, measuring]);

  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);
  // 패턴·미러의 원본: 선택한 돌출/회전, 없으면 마지막 돌출/회전
  const isTool = (f?: Feature) => f?.type === "extrude" || f?.type === "revolve";
  const selected = doc.features.find((f) => f.id === selectedId);
  const editing = solved?.doc.features.find((f) => f.id === editingId);
  const extrudeTarget = selected?.type === "sketch" ? selected.id
    : [...doc.features].reverse().find((f) => f.type === "sketch")?.id;
  const patternSource = isTool(selected) ? selected!.id : [...doc.features].reverse().find(isTool)?.id;
  const busyMode = !!editingId || picking;

  const errorOf = (id: string) => result?.errors.find((e) => e.featureId === id)?.message
    ?? (solved?.results[id]?.status === "over" ? solved.results[id].error ?? "구속 충돌" : undefined);
  const end = doc.rollbackIndex ?? doc.features.length;

  return (
    <div className="app">
      <header className="toolbar">
        <strong>MyCAD</strong>
        <button onClick={openDoc}>열기</button>
        <button onClick={saveDoc}>저장</button>
        <span className="sep" />
        <button onClick={undo} disabled={!history.canUndo} title="Ctrl+Z">↶ 실행 취소</button>
        <button onClick={redo} disabled={!history.canRedo} title="Ctrl+Y">↷ 다시 실행</button>
        <span className="sep" />
        <span className="menu">
          <button disabled={busyMode || !solverReady}>✎ 새 스케치 ▾</button>
          {/* 항목을 고르면 포커스를 풀어서 메뉴가 닫히게 함 */}
          <span className="menu-items" onClick={() => (document.activeElement as HTMLElement | null)?.blur()}>
            {(["XY", "XZ", "YZ"] as const).map((p) => (
              <button key={p} onClick={() => newSketch(p)}>{p} 평면</button>
            ))}
            <button disabled={!result?.mesh} onClick={() => setPicking(true)}>면 선택…</button>
          </span>
        </span>
        <button disabled={busyMode || !extrudeTarget} onClick={() => extrudeTarget && run(addExtrude(extrudeTarget))}
          title="선택한 스케치(없으면 마지막 스케치)를 돌출">⬆ 돌출</button>
        <button disabled={busyMode || !extrudeTarget} onClick={() => extrudeTarget && run(addRevolve(extrudeTarget))}
          title="선택한 스케치(없으면 마지막 스케치)를 축 둘레로 회전">⟳ 회전</button>
        <button disabled={busyMode || !result?.mesh} onClick={() => run(addShell())} title="바디 속을 비움">▢ 쉘</button>
        <button disabled={busyMode || !extrudeTarget || !result?.mesh} onClick={() => extrudeTarget && run(addSketchHole(extrudeTarget))}
          title="선택한 스케치(없으면 마지막 스케치)의 점마다 구멍">◎ 구멍</button>
        <button disabled={busyMode || !patternSource} onClick={() => patternSource && run(addPattern(patternSource))}
          title="선택한 돌출/회전(없으면 마지막 것)을 반복 복제">⋯ 패턴</button>
        <button disabled={busyMode || !patternSource} onClick={() => patternSource && run(addMirror(patternSource))}
          title="선택한 돌출/회전(없으면 마지막 것)을 대칭 복제">⇋ 미러</button>
        <span className="sep" />
        <button className={measuring ? "on" : ""} disabled={!!editingId || !result?.mesh} onClick={() => setMeasuring((m) => !m)}
          title="두 점 거리, 면 면적 측정">📏 측정</button>
        <span className="sep" />
        <span className="menu">
          <button>⤓ 내보내기 ▾</button>
          <span className="menu-items" onClick={() => (document.activeElement as HTMLElement | null)?.blur()}>
            <button onClick={() => exportAs("stl")}>STL (3D 프린팅)</button>
            <button onClick={() => exportAs("3mf")}>3MF (3D 프린팅)</button>
            <button onClick={() => exportAs("step")}>STEP (CAD 교환)</button>
          </span>
        </span>
      </header>

      <aside className="panel">
        <h3>파라미터</h3>
        {doc.parameters.map((p) => (
          <ExprField key={p.name} label={`${p.name} (${p.unit})`} value={p.expr}
            onCommit={(v) => run(setParameter(p.name, v))} error={errorOf("parameters")} />
        ))}

        {editing?.type === "sketch" ? (
          <SketchPanel sketchId={editing.id} doc={doc} result={solved?.results[editing.id]} run={run} />
        ) : selected ? (
          <FeaturePanel f={selected} doc={doc} result={solved?.results[selected.id]} error={errorOf(selected.id)}
            run={run} onEdit={() => setEditingId(selected.id)}
            onDelete={() => { run(deleteFeature(selected.id)); }} />
        ) : (
          <>
            <p className="info">타임라인에서 피처를 클릭하면 속성이 여기에 나옵니다. (Esc: 선택 해제)</p>
            {result?.props && <InspectPanel props={result.props} />}
          </>
        )}
        {result?.volume !== undefined && <p className="info">부피: {result.volume.toFixed(3)} mm³</p>}
      </aside>

      <main className="view">
        {editing?.type === "sketch" ? (
          <SketchEditor key={editing.id} sketch={editing.sketch} result={solved?.results[editing.id]} scope={scope}
            onCommit={(sk) => run(updateSketch(editing.id, sk))} onExit={() => setEditingId(undefined)} />
        ) : (
          <>
            <Viewport mesh={result?.mesh} doc={shown} highlight={selectedId}
              pickFace={picking ? (face) => {
                setPicking(false);
                const r = (v: number) => Math.round(v * 1e6) / 1e6;
                newSketch({ ...planeFromNormal(face.origin.map(r) as [number, number, number], face.normal.map(r) as [number, number, number],
                  `면 (${face.normal.map((v) => r(v)).join(", ")})`), follow: true });
              } : undefined} measure={measuring && !picking} />
            {busy && <div className="busy">계산 중…</div>}
            {picking && <div className="pick-hint">스케치할 <b>평평한 면</b>을 클릭하세요 · Esc 취소</div>}
          </>
        )}
      </main>

      <footer className="timeline">
        <span className="label">타임라인</span>
        {doc.features.map((f, i) => (
          <button key={f.id}
            className={["chip", f.suppressed && "off", i >= end && "rolled", errorOf(f.id) && "err", f.id === selectedId && "sel"]
              .filter(Boolean).join(" ")}
            title={errorOf(f.id) ?? "클릭: 선택 · 더블클릭: 스케치 편집 · 우클릭: 여기까지 롤백"}
            onClick={() => setSelectedId(f.id)}
            onDoubleClick={() => f.type === "sketch" && setEditingId(f.id)}
            onContextMenu={(e) => { e.preventDefault(); run(setRollback(i + 1 === doc.features.length ? undefined : i + 1)); }}>
            {errorOf(f.id) ? "⚠ " : ""}{FEATURE_LABEL[f.type]} · {f.name}
          </button>
        ))}
        <span className="status">{solverReady ? status : "솔버 불러오는 중…"}</span>
      </footer>
    </div>
  );
}

function FeaturePanel({ f, doc, result, error, run, onEdit, onDelete }: {
  f: Feature; doc: CadDocument; result?: SolveResult; error?: string;
  run: (c: Command) => void; onEdit: () => void; onDelete: () => void;
}) {
  return (
    <>
      <h3>{FEATURE_LABEL[f.type]} · {f.name}</h3>
      {error && <p className="error">⚠ {error}</p>}
      {f.type === "sketch" && (
        <>
          <p className="info">평면 {planeLabel(f.sketch.plane)} · 곡선 {f.sketch.curves.length}개 · 구속 {f.sketch.constraints.length}개
            <br />{statusText(result)}</p>
          <button className="wide" onClick={onEdit}>✎ 스케치 편집</button>
        </>
      )}
      {f.type === "sketch" && typeof f.sketch.plane !== "string" && (
        <label className="field check">
          <input type="checkbox" checked={!!f.sketch.plane.follow} onChange={(e) => run(setSketchFollow(f.id, e.target.checked))} />
          <span>면 따라가기 (모델이 바뀌면 면 위치를 다시 찾음)</span>
        </label>
      )}
      {f.type === "sketchHole" && (
        <>
          <Choice label="스케치 (점 위치)" value={f.sketchId} onChange={(v) => run(setFeatureField(f.id, "sketchId", v))}
            options={doc.features.filter((x) => x.type === "sketch").map((x) => [x.id, x.name])} />
          <Choice label="종류" value={f.kind} onChange={(v) => run(setFeatureField(f.id, "kind", v))}
            options={[["simple", "단순"], ["counterbore", "카운터보어"], ["countersink", "접시머리 (90°)"]]} />
          <Choice label="방향" value={f.side} onChange={(v) => run(setFeatureField(f.id, "side", v))}
            options={[["in", "면 안쪽으로"], ["out", "반대쪽으로"]]} />
        </>
      )}
      {(f.type === "extrude" || f.type === "revolve") && (
        <>
          <Choice label="스케치" value={f.sketchId} onChange={(v) => run(setFeatureField(f.id, "sketchId", v))}
            options={doc.features.filter((x) => x.type === "sketch").map((x) => [x.id, x.name])} />
          <Choice label="연산" value={f.operation} onChange={(v) => run(setFeatureField(f.id, "operation", v))}
            options={Object.entries(OPERATION_LABEL)} />
        </>
      )}
      {f.type === "revolve" && (
        <Choice label="회전축" value={f.axis} onChange={(v) => run(setFeatureField(f.id, "axis", v))}
          options={[["X", "스케치 X축"], ["Y", "스케치 Y축"], ...revolveAxisLines(doc, f.sketchId)]} />
      )}
      {f.type === "shell" && (
        <Choice label="열 면" value={f.openFace} onChange={(v) => run(setFeatureField(f.id, "openFace", v))}
          options={[["+Z", "위 (+Z)"], ["-Z", "아래 (−Z)"], ["+X", "+X 끝"], ["-X", "−X 끝"], ["+Y", "+Y 끝"], ["-Y", "−Y 끝"]]} />
      )}
      {(f.type === "pattern" || f.type === "mirror") && (
        <Choice label="원본" value={f.sourceId} onChange={(v) => run(setFeatureField(f.id, "sourceId", v))}
          options={doc.features.filter((x) => (x.type === "extrude" || x.type === "revolve") && doc.features.indexOf(x) < doc.features.indexOf(f))
            .map((x) => [x.id, x.name])} />
      )}
      {f.type === "pattern" && (
        <>
          <Choice label="종류" value={f.mode} onChange={(v) => run(setFeatureField(f.id, "mode", v))}
            options={[["linear", "직선"], ["circular", "원형 (원점 축 둘레)"]]} />
          <Choice label={f.mode === "linear" ? "방향" : "회전축"} value={f.axis} onChange={(v) => run(setFeatureField(f.id, "axis", v))}
            options={[["X", "X"], ["Y", "Y"], ["Z", "Z"]]} />
        </>
      )}
      {f.type === "mirror" && (
        <Choice label="대칭 평면" value={f.plane} onChange={(v) => run(setFeatureField(f.id, "plane", v))}
          options={[["YZ", "YZ (X 뒤집기)"], ["XZ", "XZ (Y 뒤집기)"], ["XY", "XY (Z 뒤집기)"]]} />
      )}
      {Object.entries(f.params)
        .filter(([k]) => f.type !== "pattern" || (f.mode === "linear" ? k !== "angle" : k !== "distance"))
        .filter(([k]) => f.type !== "sketchHole" || (k !== "headDiameter" || f.kind !== "simple") && (k !== "headDepth" || f.kind === "counterbore"))
        .map(([k, v]) => (
          <ExprField key={k} label={f.type === "pattern" && k === "distance" ? "간격" : f.type === "pattern" && k === "angle" ? "전체 각도 (360 = 한 바퀴)" : PARAM_LABEL[k] ?? k}
            value={v as string} onCommit={(nv) => run(setFeatureParam(f.id, k, nv))} />
        ))}
      <div className="row">
        <button onClick={() => run(toggleSuppress(f.id))}>{f.suppressed ? "억제 해제" : "억제"}</button>
        <button className="danger" onClick={onDelete}>삭제</button>
      </div>
    </>
  );
}

function SketchPanel({ sketchId, doc, result, run }: { sketchId: string; doc: CadDocument; result?: SolveResult; run: (c: Command) => void }) {
  const f = doc.features.find((x) => x.id === sketchId);
  if (f?.type !== "sketch") return null;
  const sk = f.sketch;
  const conflicts = new Set(result?.conflicts ?? []);
  const setValue = (kid: string, value: string) =>
    run(updateSketch(sketchId, { ...sk, constraints: sk.constraints.map((k) => (k.id === kid && "value" in k ? { ...k, value } : k)) }));
  const remove = (kid: string) => run(updateSketch(sketchId, { ...sk, constraints: sk.constraints.filter((k) => k.id !== kid) }));
  return (
    <>
      <h3>스케치 편집 · {f.name} ({planeLabel(sk.plane)})</h3>
      <p className="info">{statusText(result)}</p>
      <h3>구속조건</h3>
      {sk.constraints.length === 0 && <p className="info">아직 없습니다. 요소를 선택하고 위 버튼으로 추가하세요.</p>}
      <ul className="constraints">
        {sk.constraints.map((k) => (
          <li key={k.id} className={conflicts.has(k.id) ? "bad" : ""}>
            <span>{CONSTRAINT_LABEL[k.kind]}{"axis" in k ? ` ${k.axis}` : ""}</span>
            {"value" in k
              ? <ExprField label="" value={k.value} onCommit={(v) => setValue(k.id, v)} />
              : <span className="grow" />}
            <button title="삭제" onClick={() => remove(k.id)}>✕</button>
          </li>
        ))}
      </ul>
    </>
  );
}

const CONSTRAINT_LABEL: Record<string, string> = {
  coincident: "일치", horizontal: "수평", vertical: "수직", parallel: "평행", perpendicular: "직교",
  equal: "동일", pointOnLine: "점→선", tangent: "접선", distance: "거리", length: "길이", radius: "반지름", coordinate: "좌표",
};

function statusText(r?: SolveResult) {
  if (!r) return "";
  if (r.status === "full") return "● 완전 구속";
  if (r.status === "over") return `● 충돌: ${r.error ?? ""}`;
  return `● 덜 구속 (자유도 ${Math.max(r.dof, 0)})`;
}

// 수식 입력칸: Enter나 포커스 이동 시 확정, Esc로 취소
function ExprField({ label, value, onCommit, error }: { label: string; value: string; onCommit: (v: string) => void; error?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft.trim() && draft !== value) onCommit(draft.trim()); };
  return (
    <label className="field">
      {label && <span>{label}</span>}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setDraft(value); }}
        className={error ? "bad" : ""} title={error} />
    </label>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  const known = options.some(([v]) => v === value);
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={value}>(없음)</option>}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

// 회전축 후보: 스케치 안의 선들 (보조선을 먼저)
function revolveAxisLines(doc: CadDocument, sketchId: string): [string, string][] {
  const sk = doc.features.find((x) => x.id === sketchId);
  if (sk?.type !== "sketch") return [];
  return sk.sketch.curves
    .filter((c) => c.kind === "line")
    .sort((a, b) => Number(!!b.construction) - Number(!!a.construction))
    .map((c, i) => [c.id, `${c.construction ? "보조선" : "선"} ${i + 1}`]);
}

// 검사 (M3): 부피, 표면적, 무게중심, 크기, 재료별 질량
function InspectPanel({ props }: { props: MassProps }) {
  const [mat, setMat] = useState(() => { try { return localStorage.getItem("mycad.material") ?? "PLA"; } catch { return "PLA"; } });
  const density = MATERIALS.find(([n]) => n === mat)?.[1] ?? 1.24;
  const [lo, hi] = props.bounds;
  const f = (v: number, d = 2) => v.toFixed(d);
  return (
    <>
      <h3>검사</h3>
      <table className="props">
        <tbody>
          <tr><td>부피</td><td>{f(props.volume / 1000, 3)} cm³</td></tr>
          <tr><td>표면적</td><td>{f(props.area / 100, 2)} cm²</td></tr>
          <tr><td>크기</td><td>{f(hi[0] - lo[0])} × {f(hi[1] - lo[1])} × {f(hi[2] - lo[2])} mm</td></tr>
          <tr><td>무게중심</td><td>({props.centerOfMass.map((v) => f(v)).join(", ")})</td></tr>
          <tr><td>재료</td><td>
            <select value={mat} onChange={(e) => { setMat(e.target.value); try { localStorage.setItem("mycad.material", e.target.value); } catch { /* 저장 불가 환경 */ } }}>
              {MATERIALS.map(([n, d]) => <option key={n} value={n}>{n} ({d} g/cm³)</option>)}
            </select>
          </td></tr>
          <tr><td>질량</td><td><b>{f((props.volume * density) / 1000)} g</b></td></tr>
        </tbody>
      </table>
    </>
  );
}
