import type { CadDocument } from "@my-cad/core";
import type { FeatureError, MeshData } from "./build";

export interface BuildReply { mesh?: MeshData; errors: FeatureError[]; volume?: number; }

// UI 쪽에서 쓰는 워커 클라이언트 (요청 ID로 응답을 매칭)
export class KernelClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (ev) => {
      const { id, ok, error, ...rest } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      ok ? p.resolve(rest) : p.reject(new Error(error));
    };
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || "커널 워커 오류"));
      this.pending.clear();
    };
  }

  private call<T>(msg: object): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  build(doc: CadDocument) { return this.call<BuildReply>({ kind: "build", doc }); }
  async export(doc: CadDocument, format: "stl" | "step") {
    return (await this.call<{ data: ArrayBuffer }>({ kind: "export", doc, format })).data;
  }
}
