import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  // OCCT WASM 모듈은 사전 번들링하지 않음 (wasm 경로가 깨지는 것 방지)
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  build: { target: "es2022" },
  server: { port: 5173, strictPort: true },
  clearScreen: false,
});
