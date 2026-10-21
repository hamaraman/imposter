import { nextId, type CadDocument, type ExtrudeOperation } from "./document";
import { emptySketch, type SketchData, type SketchPlane } from "./sketch";

// 명세 F-21: 모든 변경은 명령으로. 문서는 불변으로 다루고 스냅샷으로 Undo 처리
export type Command = (doc: CadDocument) => CadDocument;

export class History {
  private past: CadDocument[] = [];
  private future: CadDocument[] = [];
  constructor(public current: CadDocument, private limit = 100) {}

  run(cmd: Command): CadDocument {
    const next = cmd(structuredClone(this.current));
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return (this.current = next);
  }
  undo() { const p = this.past.pop(); if (p) { this.future.push(this.current); this.current = p; } return this.current; }
  redo() { const f = this.future.pop(); if (f) { this.past.push(this.current); this.current = f; } return this.current; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

export const setParameter = (name: string, expr: string): Command => (doc) => {
  const p = doc.parameters.find((x) => x.name === name);
  if (!p) throw new Error(`파라미터 없음: ${name}`);
  p.expr = expr;
  return doc;
};

export const setFeatureParam = (id: string, key: string, expr: string): Command => (doc) => {
  const f = doc.features.find((x) => x.id === id);
  if (!f) throw new Error(`피처 없음: ${id}`);
  (f.params as Record<string, string>)[key] = expr;
  return doc;
};

export const toggleSuppress = (id: string): Command => (doc) => {
  const f = doc.features.find((x) => x.id === id);
  if (f) f.suppressed = !f.suppressed;
  return doc;
};

export const setRollback = (index: number | undefined): Command => (doc) => {
  doc.rollbackIndex = index;
  return doc;
};

// 롤백 막대가 있으면 그 위치에, 없으면 맨 끝에 피처를 끼워 넣는다
function insertFeature(doc: CadDocument, f: CadDocument["features"][number]) {
  const at = doc.rollbackIndex ?? doc.features.length;
  doc.features.splice(at, 0, f);
  if (doc.rollbackIndex !== undefined) doc.rollbackIndex = at + 1;
}

export const addSketch = (plane: SketchPlane, onCreated?: (id: string) => void): Command => (doc) => {
  const id = nextId(doc, "s");
  insertFeature(doc, { id, type: "sketch", name: `Sketch ${id.slice(1)}`, params: {}, sketch: emptySketch(plane) });
  onCreated?.(id);
  return doc;
};

export const updateSketch = (id: string, sketch: SketchData): Command => (doc) => {
  const f = doc.features.find((x) => x.id === id);
  if (f?.type !== "sketch") throw new Error(`스케치 없음: ${id}`);
  f.sketch = sketch;
  return doc;
};

export const addExtrude = (sketchId: string, distance = "10"): Command => (doc) => {
  const at = doc.rollbackIndex ?? doc.features.length;
  const hasBody = doc.features.slice(0, at).some((f) => !f.suppressed && (f.type === "box" || f.type === "extrude"));
  const id = nextId(doc, "f");
  insertFeature(doc, { id, type: "extrude", name: `Extrude ${id.slice(1)}`, sketchId,
    operation: hasBody ? "join" : "new", params: { distance } });
  return doc;
};

export const setExtrudeOperation = (id: string, operation: ExtrudeOperation): Command => (doc) => {
  const f = doc.features.find((x) => x.id === id);
  if (f?.type === "extrude") f.operation = operation;
  return doc;
};

export const deleteFeature = (id: string): Command => (doc) => {
  const i = doc.features.findIndex((f) => f.id === id);
  if (i < 0) return doc;
  if (doc.features.some((f) => f.type === "extrude" && f.sketchId === id))
    throw new Error("이 스케치를 쓰는 돌출이 있어서 지울 수 없습니다. 돌출을 먼저 지우세요");
  doc.features.splice(i, 1);
  if (doc.rollbackIndex !== undefined && i < doc.rollbackIndex) doc.rollbackIndex--;
  return doc;
};
