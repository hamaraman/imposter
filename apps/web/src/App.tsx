import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  History, newDocument, serialize, deserialize, setParameter, setFeatureParam, toggleSuppress, setRollback,
  addSketch, updateSketch, addExtrude, setExtrudeOperation, deleteFeature, resolveParameters,
  type CadDocument, type Command, type ExtrudeOperation, type Feature, type SketchPlane, type Scope,
} from "@my-cad/core";
import { solveDocument, type SolveResult } from "@my-cad/sketch";
import { initBrowserSolver } from "@my-cad/sketch/src/browser";
import { KernelClient, type BuildReply } from "@my-cad/kernel/src/client";
import { Viewport } from "./Viewport";
import { SketchEditor } from "./SketchEditor";
import { openTextFile, saveFile } from "./platform";

const FEATURE_LABEL: Record<Feature["type"], string> = {
  box: "박스", fillet: "필렛", hole: "구멍", sketch: "스케치", extrude: "돌출",
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
  const latest = useRef(0);

  useEffect(() => {
    initBrowserSolver().then(() => setSolverReady(true)).catch((e) => setStatus(`솔버 오류: ${e.message}`));
  }, []);

  // 1단계: 모든 스케치를 현재 파라미터로 다시 풂 (메인 스레드, 수 ms)
  const solved = useMemo(() => (solverReady ? solveDocument(doc) : undefined), [doc, solverReady]);
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

  const exportAs = async (format: "stl" | "step") => {
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
  const selected = doc.features.find((f) => f.id === selectedId);
  const editing = solved?.doc.features.find((f) => f.id === editingId);
  const extrudeTarget = selected?.type === "sketch" ? selected.id
    : [...doc.features].reverse().find((f) => f.type === "sketch")?.id;

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
          <button disabled={!!editingId || !solverReady}>✎ 새 스케치 ▾</button>
          <span className="menu-items">
            {(["XY", "XZ", "YZ"] as SketchPlane[]).map((p) => (
              <button key={p} onClick={() => newSketch(p)}>{p} 평면</button>
            ))}
          </span>
        </span>
        <button disabled={!!editingId || !extrudeTarget} onClick={() => extrudeTarget && run(addExtrude(extrudeTarget))}
          title="선택한 스케치(없으면 마지막 스케치)를 돌출">⬆ 돌출</button>
        <span className="sep" />
        <button onClick={() => exportAs("stl")}>STL 내보내기</button>
        <button onClick={() => exportAs("step")}>STEP 내보내기</button>
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
          <p className="info">타임라인에서 피처를 클릭하면 속성이 여기에 나옵니다.</p>
        )}
        {result?.volume !== undefined && <p className="info">부피: {result.volume.toFixed(3)} mm³</p>}
      </aside>

      <main className="view">
        {editing?.type === "sketch" ? (
          <SketchEditor key={editing.id} sketch={editing.sketch} result={solved?.results[editing.id]} scope={scope}
            onCommit={(sk) => run(updateSketch(editing.id, sk))} onExit={() => setEditingId(undefined)} />
        ) : (
          <>
            <Viewport mesh={result?.mesh} doc={solved?.doc} highlight={selectedId} />
            {busy && <div className="busy">계산 중…</div>}
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
          <p className="info">평면 {f.sketch.plane} · 곡선 {f.sketch.curves.length}개 · 구속 {f.sketch.constraints.length}개
            <br />{statusText(result)}</p>
          <button className="wide" onClick={onEdit}>✎ 스케치 편집</button>
        </>
      )}
      {f.type === "extrude" && (
        <>
          <label className="field">
            <span>스케치</span>
            <span>{doc.features.find((x) => x.id === f.sketchId)?.name ?? "(없음)"}</span>
          </label>
          <label className="field">
            <span>연산</span>
            <select value={f.operation} onChange={(e) => run(setExtrudeOperation(f.id, e.target.value as ExtrudeOperation))}>
              {(Object.keys(OPERATION_LABEL) as ExtrudeOperation[]).map((o) => <option key={o} value={o}>{OPERATION_LABEL[o]}</option>)}
            </select>
          </label>
        </>
      )}
      {Object.entries(f.params).map(([k, v]) => (
        <ExprField key={k} label={k === "distance" ? "거리 (음수: 반대 방향)" : k} value={v as string}
          onCommit={(nv) => run(setFeatureParam(f.id, k, nv))} />
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
      <h3>스케치 편집 · {f.name} ({sk.plane})</h3>
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
