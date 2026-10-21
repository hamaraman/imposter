import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MeshData } from "@my-cad/kernel/src/build";
import { activeFeatures, planeTo3d, type CadDocument, type SketchData } from "@my-cad/core";

// 명세 F-02: 궤도/이동/확대 뷰포트. CAD 관례대로 Z축이 위
export function Viewport({ mesh, doc, highlight }: { mesh?: MeshData; doc?: CadDocument; highlight?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{ scene: THREE.Scene; group: THREE.Group; sketches: THREE.Group; fit: () => void }>();

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef1f5);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    camera.position.set(80, -100, 70);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, -2, 3);
    scene.add(sun);
    const grid = new THREE.GridHelper(200, 20, 0x9aa5b1, 0xcfd6de);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid, new THREE.AxesHelper(20));

    const group = new THREE.Group();
    const sketches = new THREE.Group();
    scene.add(group, sketches);

    const fit = () => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const c = box.getCenter(new THREE.Vector3());
      const r = box.getSize(new THREE.Vector3()).length();
      controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(0.8, -1, 0.7).normalize().multiplyScalar(r * 1.6));
    };
    sceneRef.current = { scene, group, sketches, fit };

    const resize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight);
      camera.aspect = el.clientWidth / Math.max(el.clientHeight, 1);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf = 0;
    const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, []);

  const firstFit = useRef(true);
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.group.children.forEach((c) => { (c as THREE.Mesh).geometry?.dispose(); });
    s.group.clear();
    if (!mesh) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x8fa9c7, metalness: 0.1, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
    const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0x1f2a37 }));
    s.group.add(body, edges);
    if (firstFit.current) { s.fit(); firstFit.current = false; }
  }, [mesh]);

  // 스케치를 3D 공간에 선으로 표시 (선택된 스케치는 주황색)
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.sketches.children.forEach((c) => (c as THREE.LineSegments).geometry.dispose());
    s.sketches.clear();
    if (!doc) return;
    for (const f of activeFeatures(doc)) {
      if (f.type !== "sketch") continue;
      const pos = sketchSegments(f.sketch);
      if (pos.length === 0) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const on = f.id === highlight;
      s.sketches.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: on ? 0xf59e0b : 0x2563eb, depthTest: !on })));
    }
  }, [doc, highlight]);

  return <div ref={host} style={{ position: "absolute", inset: 0 }} />;
}

function sketchSegments(sk: SketchData): number[] {
  const pts = new Map(sk.points.map((p) => [p.id, p]));
  const out: number[] = [];
  const seg = (a: [number, number], b: [number, number]) => out.push(...planeTo3d(sk.plane, ...a), ...planeTo3d(sk.plane, ...b));
  for (const c of sk.curves) {
    if (c.kind === "line") {
      const a = pts.get(c.p1), b = pts.get(c.p2);
      if (a && b) seg([a.x, a.y], [b.x, b.y]);
      continue;
    }
    const cc = pts.get(c.c);
    if (!cc) continue;
    let a0 = 0, a1 = 2 * Math.PI;
    if (c.kind === "arc") {
      const s = pts.get(c.s), e = pts.get(c.e);
      if (!s || !e) continue;
      a0 = Math.atan2(s.y - cc.y, s.x - cc.x); a1 = Math.atan2(e.y - cc.y, e.x - cc.x);
      if (a1 <= a0) a1 += 2 * Math.PI;
    }
    const n = 48;
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      seg([cc.x + c.r * Math.cos(t0), cc.y + c.r * Math.sin(t0)], [cc.x + c.r * Math.cos(t1), cc.y + c.r * Math.sin(t1)]);
    }
  }
  return out;
}
