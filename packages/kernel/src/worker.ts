/// <reference lib="webworker" />
// 무거운 커널 연산은 Web Worker에서 실행해서 UI가 멈추지 않게 한다
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import type { CadDocument } from "@my-cad/core";
import { buildDocument, massProps, meshShape } from "./build";
import { shapeTo3mf } from "./threemf";

const ready = opencascade({ locateFile: () => wasmUrl }).then((oc: unknown) => { setOC(oc as never); });

export type WorkerRequest =
  | { id: number; kind: "build"; doc: CadDocument }
  | { id: number; kind: "export"; doc: CadDocument; format: "stl" | "step" | "3mf" };

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    await ready;
    const result = buildDocument(req.doc);
    if (req.kind === "build") {
      const mesh = result.shape ? meshShape(result.shape) : undefined;
      const transfer = mesh ? [mesh.vertices.buffer, mesh.normals.buffer, mesh.triangles.buffer, mesh.edges.buffer] : [];
      const props = result.shape ? massProps(result.shape) : undefined;
      self.postMessage({ id: req.id, ok: true, mesh, errors: result.errors, volume: result.volume, props, planes: result.planes }, { transfer });
    } else {
      if (!result.shape) throw new Error("내보낼 형상이 없습니다");
      const data = req.format === "3mf" ? shapeTo3mf(result.shape).buffer
        : await (req.format === "stl" ? result.shape.blobSTL({ binary: true }) : result.shape.blobSTEP()).arrayBuffer();
      self.postMessage({ id: req.id, ok: true, data }, { transfer: [data as ArrayBuffer] });
    }
  } catch (e) {
    self.postMessage({ id: req.id, ok: false, error: (e as Error).message ?? String(e) });
  }
};
