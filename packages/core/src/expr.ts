// 안전한 수식 계산기: 숫자, + - * / ^, 괄호, 파라미터 이름만 허용 (eval 사용 안 함)
export type Scope = Record<string, number>;

export function evaluate(src: string, scope: Scope): number {
  const tokens = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|[A-Za-z_]\w*|[-+*/^()]/g) ?? [];
  if (tokens.join("") !== src.replace(/\s+/g, "")) throw new Error(`수식에 허용되지 않는 문자: "${src}"`);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  const primary = (): number => {
    const t = next();
    if (t === undefined) throw new Error(`수식이 끝나지 않음: "${src}"`);
    if (t === "(") { const v = add(); if (next() !== ")") throw new Error("괄호 짝이 맞지 않음"); return v; }
    if (t === "-") return -primary();
    if (t === "+") return primary();
    if (/^\d/.test(t)) return parseFloat(t);
    if (t === "pi") return Math.PI;
    if (t in scope) return scope[t];
    throw new Error(`알 수 없는 파라미터: ${t}`);
  };
  const pow = (): number => { const b = primary(); return peek() === "^" ? (next(), b ** pow()) : b; };
  const mul = (): number => {
    let v = pow();
    while (peek() === "*" || peek() === "/") v = next() === "*" ? v * pow() : v / pow();
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + mul() : v - mul();
    return v;
  };

  const v = add();
  if (i < tokens.length) throw new Error(`수식 해석 실패: "${src}"`);
  if (!Number.isFinite(v)) throw new Error(`수식 결과가 유효한 숫자가 아님: "${src}"`);
  return v;
}
