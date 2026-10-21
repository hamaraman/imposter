import { evaluate, type Scope } from "./expr";

// 명세 F-17: 사용자 파라미터
export interface Parameter { name: string; expr: string; unit: "mm" | "deg" | ""; }

// 명세 F-08/F-10: M0에서 지원하는 피처. 값은 모두 수식 문자열
export type Feature =
  | { id: string; type: "box"; name: string; suppressed?: boolean;
      params: { width: string; depth: string; height: string } }
  | { id: string; type: "fillet"; name: string; suppressed?: boolean;
      params: { radius: string } }
  | { id: string; type: "hole"; name: string; suppressed?: boolean;
      params: { diameter: string; x: string; y: string } };

export interface CadDocument {
  format: "my-cad/1";
  parameters: Parameter[];
  features: Feature[];   // 타임라인 순서 = 배열 순서 (F-16)
  rollbackIndex?: number; // 이 인덱스까지만 계산 (없으면 전체)
}

export function newDocument(): CadDocument {
  return {
    format: "my-cad/1",
    parameters: [
      { name: "width", expr: "40", unit: "mm" },
      { name: "depth", expr: "30", unit: "mm" },
      { name: "height", expr: "10", unit: "mm" },
    ],
    features: [
      { id: "f1", type: "box", name: "Base", params: { width: "width", depth: "depth", height: "height" } },
      { id: "f2", type: "fillet", name: "Round edges", params: { radius: "2" } },
      { id: "f3", type: "hole", name: "Center hole", params: { diameter: "width/4", x: "0", y: "0" } },
    ],
  };
}

// 파라미터를 순서대로 계산. 앞쪽 파라미터만 참조 가능하므로 순환 참조가 생기지 않음
export function resolveParameters(doc: CadDocument): Scope {
  const scope: Scope = {};
  for (const p of doc.parameters) {
    if (!/^[A-Za-z_]\w*$/.test(p.name)) throw new Error(`파라미터 이름이 올바르지 않음: ${p.name}`);
    scope[p.name] = evaluate(p.expr, scope);
  }
  return scope;
}

// 피처 파라미터를 숫자로 변환
export function resolveFeature<F extends Feature>(f: F, scope: Scope): Record<keyof F["params"], number> {
  const out = {} as Record<string, number>;
  for (const [k, expr] of Object.entries(f.params)) out[k] = evaluate(expr as string, scope);
  return out as Record<keyof F["params"], number>;
}

export function activeFeatures(doc: CadDocument): Feature[] {
  const end = doc.rollbackIndex ?? doc.features.length;
  return doc.features.slice(0, end).filter((f) => !f.suppressed);
}

export function serialize(doc: CadDocument): string { return JSON.stringify(doc, null, 2); }

export function deserialize(text: string): CadDocument {
  const doc = JSON.parse(text);
  if (doc?.format !== "my-cad/1") throw new Error("지원하지 않는 파일 형식입니다");
  return doc as CadDocument;
}
