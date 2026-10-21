import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  History, newDocument, serialize, deserialize, setParameter, setFeatureParam, toggleSuppress, setRollback,
  type CadDocument, type Command,
} from "@my-cad/core";
import { KernelClient, type BuildReply } from "@my-cad/kernel/src/client";
import { Viewport } from "./Viewport";
import { openTextFile, saveFile } from "./platform";

const FEATURE_LABEL = { box: "박스(돌출)", fillet: "필렛", hole: "구멍" } as const;

export function App() {
  const history = useMemo(() => new History(newDocument()), []);
  const kernel = useMemo(() => new KernelClient(), []);
  const [doc, setDoc] = useState<CadDocument>(history.current);
  const [result, setResult] = useState<BuildReply>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("커널 불러오는 중…");
  const latest = useRef(0);

  // 문서가 바뀔 때마다 재계산. 오래된 응답은 버린다
  useEffect(() => {
    const ticket = ++latest.current;
    setBusy(true);
    const t0 = performance.now();
    kernel.build(doc)
      .then((r) => {
        if (ticket !== latest.current) return;
        setResult(r);
        setStatus(r.errors.length ? `오류 ${r.errors.length}개` : `재계산 ${Math.round(performance.now() - t0)}ms`);
      })
      .catch((e) => ticket === latest.current && setStatus(`커널 오류: ${e.message}`))
      .finally(() => ticket === latest.current && setBusy(false));
  }, [doc, kernel]);

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

  const exportAs = async (format: "stl" | "step") => {
    try {
      const data = await kernel.export(doc, format);
      if (await saveFile(`model.${format}`, new Uint8Array(data), format)) setStatus(`${format.toUpperCase()} 저장 완료`);
    } catch (e) { setStatus(`내보내기 실패: ${(e as Error).message}`); }
  };
  const saveDoc = async () => {
    try { if (await saveFile("design.mycad", serialize(doc), "mycad")) setStatus("저장 완료"); }
    catch (e) { setStatus(`저장 실패: ${(e as Error).message}`); }
  };
  const openDoc = async () => {
    try {
      const text = await openTextFile("mycad");
      if (text) { const d = deserialize(text); history.current = d; setDoc(d); setStatus("열기 완료"); }
    } catch (e) { setStatus(`열기 실패: ${(e as Error).message}`); }
  };

  const errorOf = (id: string) => result?.errors.find((e) => e.featureId === id)?.message;
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
        <button onClick={() => exportAs("stl")}>STL 내보내기</button>
        <button onClick={() => exportAs("step")}>STEP 내보내기</button>
      </header>

      <aside className="panel">
        <h3>파라미터</h3>
        {doc.parameters.map((p) => (
          <ExprField key={p.name} label={`${p.name} (${p.unit})`} value={p.expr}
            onCommit={(v) => run(setParameter(p.name, v))} error={errorOf("parameters")} />
        ))}
        <h3>피처 속성</h3>
        {doc.features.map((f) => (
          <fieldset key={f.id} className={f.suppressed ? "dim" : ""}>
            <legend>{f.name}</legend>
            {Object.entries(f.params).map(([k, v]) => (
              <ExprField key={k} label={k} value={v} onCommit={(nv) => run(setFeatureParam(f.id, k, nv))} />
            ))}
          </fieldset>
        ))}
        {result?.volume !== undefined && <p className="info">부피: {result.volume.toFixed(3)} mm³</p>}
      </aside>

      <main className="view">
        <Viewport mesh={result?.mesh} />
        {busy && <div className="busy">계산 중…</div>}
      </main>

      <footer className="timeline">
        <span className="label">타임라인</span>
        {doc.features.map((f, i) => (
          <button key={f.id}
            className={["chip", f.suppressed && "off", i >= end && "rolled", errorOf(f.id) && "err"].filter(Boolean).join(" ")}
            title={errorOf(f.id) ?? "클릭: 억제/해제 · 우클릭: 여기까지 롤백"}
            onClick={() => run(toggleSuppress(f.id))}
            onContextMenu={(e) => { e.preventDefault(); run(setRollback(i + 1 === doc.features.length ? undefined : i + 1)); }}>
            {errorOf(f.id) ? "⚠ " : ""}{FEATURE_LABEL[f.type]} · {f.name}
          </button>
        ))}
        <span className="status">{status}</span>
      </footer>
    </div>
  );
}

// 수식 입력칸: Enter나 포커스 이동 시 확정, Esc로 취소
function ExprField({ label, value, onCommit, error }: { label: string; value: string; onCommit: (v: string) => void; error?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft.trim() && draft !== value) onCommit(draft.trim()); };
  return (
    <label className="field">
      <span>{label}</span>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setDraft(value); }}
        className={error ? "bad" : ""} title={error} />
    </label>
  );
}
