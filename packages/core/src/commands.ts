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
  const id = nextId(doc, "f");
  insertFeature(doc, { id, type: "extrude", name: `Extrude ${id.slice(1)}`, sketchId,
    operation: hasBodyBefore(doc) ? "join" : "new", params: { distance } });
  return doc;
};

export const setExtrudeOperation = (id: string, operation: ExtrudeOperation): Command => setFeatureField(id, "operation", operation);

// 수식이 아닌 선택형 필드(연산, 축, 원본 피처 등)를 바꿈
export const setFeatureField = (id: string, key: string, value: string): Command => (doc) => {
  const f = doc.features.find((x) => x.id === id) as unknown as Record<string, unknown> | undefined;
  if (!f) throw new Error(`피처 없음: ${id}`);
  if (key === "id" || key === "type" || key === "params" || key === "sketch") throw new Error(`바꿀 수 없는 필드: ${key}`);
  f[key] = value;
  return doc;
};

const hasBodyBefore = (doc: CadDocument) => {
  const at = doc.rollbackIndex ?? doc.features.length;
  return doc.features.slice(0, at).some((f) => !f.suppressed && (f.type === "box" || f.type === "extrude" || f.type === "revolve"));
};

export const addRevolve = (sketchId: string): Command => (doc) => {
  const id = nextId(doc, "f");
  insertFeature(doc, { id, type: "revolve", name: `Revolve ${id.slice(1)}`, sketchId, axis: "Y",
    operation: hasBodyBefore(doc) ? "join" : "new", params: { angle: "360" } });
  return doc;
};

export const addShell = (): Command => (doc) => {
  const id = nextId(doc, "f");
  insertFeature(doc, { id, type: "shell", name: `Shell ${id.slice(1)}`, openFace: "+Z", params: { thickness: "1" } });
  return doc;
};

export const addPattern = (sourceId: string): Command => (doc) => {
  const id = nextId(doc, "f");
  insertFeature(doc, { id, type: "pattern", name: `Pattern ${id.slice(1)}`, sourceId, mode: "linear", axis: "X",
    params: { count: "3", distance: "10", angle: "360" } });
  return doc;
};

export const addSketchHole = (sketchId: string): Command => (doc) => {
  const id = nextId(doc, "f");
  insertFeature(doc, { id, type: "sketchHole", name: `Hole ${id.slice(1)}`, sketchId, kind: "simple", side: "in",
    params: { diameter: "5", depth: "0", headDiameter: "9", headDepth: "3" } });
  return doc;
};

// 면 위 스케치가 면을 따라갈지 (M5)
export const setSketchFollow = (id: string, follow: boolean): Command => (doc) => {
  const f = doc.features.find((x) => x.id === id);
  if (f?.type !== "sketch" || typeof f.sketch.plane === "string") throw new Error("면 위 스케치만 바꿀 수 있습니다");
  f.sketch.plane = { ...f.sketch.plane, follow };
  return doc;
};

export const addMirror = (sourceId: string): Command => (doc) => {
  const id = nextId(doc, "f");
  insertFeature(doc, { id, type: "mirror", name: `Mirror ${id.slice(1)}`, sourceId, plane: "YZ", params: {} });
  return doc;
};

export const deleteFeature = (id: string): Command => (doc) => {
  const i = doc.features.findIndex((f) => f.id === id);
  if (i < 0) return doc;
  const user = doc.features.find((f) =>
    ((f.type === "extrude" || f.type === "revolve" || f.type === "sketchHole") && f.sketchId === id) ||
    ((f.type === "pattern" || f.type === "mirror") && f.sourceId === id));
  if (user) throw new Error(`'${user.name}'이(가) 이 피처를 사용하고 있어서 지울 수 없습니다. 그 피처를 먼저 지우세요`);
  doc.features.splice(i, 1);
  if (doc.rollbackIndex !== undefined && i < doc.rollbackIndex) doc.rollbackIndex--;
  return doc;
};
