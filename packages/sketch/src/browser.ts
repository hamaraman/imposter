// 브라우저(Vite) 전용 진입점: WASM 파일 경로를 번들러가 처리하게 한다 (테스트는 Node에서 initSolver()를 직접 호출)
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { initSolver } from "./solver";

export const initBrowserSolver = () => initSolver(wasmUrl);
