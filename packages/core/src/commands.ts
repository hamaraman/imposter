import type { CadDocument } from "./document";

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
