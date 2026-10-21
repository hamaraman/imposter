import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FaceInfo, MeshData } from "@my-cad/kernel/src/build";
import { activeFeatures, planeTo3d, type CadDocument, type SketchData } from "@my-cad/core";

// 명세 F-02: 궤도/이동/확대 뷰포트. CAD 관례대로 Z축이 위
// pickFace가 있으면 "면 고르기" 모드: 평평한 면에 마우스를 올리면 강조되고, 클릭하면 그 면을 넘겨줌
// measure가 켜져 있으면 측정 모드 (M3): 바디 위 두 점의 거리, 클릭한 면의 종류·면적
export function Viewport({ mesh, doc, highlight, pickFace, measure }: {
  mesh?: MeshData; doc?: CadDocument; highlight?: string; pickFace?: (face: FaceInfo) => void; measure?: boolean;
}) {
  const [picks, setPicks] = useState<{ p: [number, number, number]; face?: FaceInfo }[]>([]);
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const marksRef = useRef<THREE.Group>();
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene; group: THREE.Group; sketches: THREE.Group; fit: () => void;
    camera: THREE.PerspectiveCamera; dom: HTMLCanvasElement; hover: THREE.Mesh; view: (dir: [number, number, number]) => void;
  }>();
  const bodyRef = useRef<THREE.Mesh>();
  const pickRef = useRef(pickFace);
  pickRef.current = pickFace;
  const meshRef = useRef(mesh);
  meshRef.current = mesh;

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // 배경은 CSS 그라데이션
    renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    camera.position.set(80, -100, 70);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3340, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, -2, 3);
    scene.add(sun);
    const grid = new THREE.GridHelper(200, 20, 0x5b6676, 0x343c48);
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
    // 면 강조용 반투명 메시 (면 고르기 모드에서만 보임)
    const hover = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0xf59e0b, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide,
    }));
    hover.visible = false;
    scene.add(hover);
    // 표준 시점: 바디 중심을 보면서 주어진 방향에서 바라봄
    const view = (dir: [number, number, number]) => {
      const box = new THREE.Box3().setFromObject(group);
      const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      const r = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length();
      controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(...dir).normalize().multiplyScalar(r * 1.6));
      camera.up.set(0, 0, 1);
      if (Math.abs(dir[2]) > 0.99) camera.up.set(0, 1, 0); // 위에서 볼 때는 Y가 화면 위
      camera.lookAt(c);
      controls.update();
    };
    sceneRef.current = { scene, group, sketches, fit, camera, dom: renderer.domElement, hover, view };

    // 화면 좌표 → 몸체의 면 번호 (삼각형 번호가 속한 faceGroup)
    const ray = new THREE.Raycaster();
    const rayHit = (ev: PointerEvent): { point: THREE.Vector3; group?: number } | undefined => {
      const body = bodyRef.current, m = meshRef.current;
      if (!body || !m) return undefined;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObject(body)[0];
      if (!hit || hit.faceIndex == null) return undefined;
      const idx = hit.faceIndex * 3;
      const g = m.faceGroups.findIndex((fg) => idx >= fg.start && idx < fg.start + fg.count);
      return { point: hit.point, group: g < 0 ? undefined : g };
    };
    const faceAt = (ev: PointerEvent) => rayHit(ev)?.group;
    const marks = new THREE.Group();
    scene.add(marks);
    marksRef.current = marks;
    const showHover = (g: number | undefined) => {
      const m = meshRef.current;
      if (g === undefined || !m || !m.faces[g]?.planar) { hover.visible = false; return; }
      const fg = m.faceGroups[g];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
      geo.setIndex(new THREE.BufferAttribute(m.triangles.slice(fg.start, fg.start + fg.count), 1));
      hover.geometry.dispose();
      hover.geometry = geo;
      hover.visible = true;
    };
    let down: { x: number; y: number } | undefined;
    const onMove = (ev: PointerEvent) => {
      if (!pickRef.current) { hover.visible = false; return; }
      const g = faceAt(ev);
      showHover(g);
      renderer.domElement.style.cursor = g !== undefined && meshRef.current?.faces[g]?.planar ? "pointer" : "not-allowed";
    };
    const onDown = (ev: PointerEvent) => { down = { x: ev.clientX, y: ev.clientY }; };
    const onUp = (ev: PointerEvent) => {
      if (measureRef.current && down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) <= 4) {
        const h = rayHit(ev);
        if (!h) return;
        const face = h.group === undefined ? undefined : meshRef.current?.faces[h.group];
        const pick = { p: h.point.toArray() as [number, number, number], face };
        setPicks((prev) => (prev.length >= 2 ? [pick] : [...prev, pick]));
        return;
      }
      // 드래그(카메라 회전)가 아니라 클릭일 때만 고름
      if (!pickRef.current || !down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4) return;
      const g = faceAt(ev);
      const face = g === undefined ? undefined : meshRef.current?.faces[g];
      if (face?.planar) { hover.visible = false; pickRef.current(face); }
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

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
    bodyRef.current = undefined;
    if (!mesh) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0xa9bccf, metalness: 0.15, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
    const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0x0b1017 }));
    s.group.add(body, edges);
    bodyRef.current = body;
    if (firstFit.current) { s.fit(); firstFit.current = false; }
  }, [mesh]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (!pickFace) { s.hover.visible = false; s.dom.style.cursor = measure ? "crosshair" : ""; }
  }, [pickFace, measure]);

  useEffect(() => { if (!measure) setPicks([]); }, [measure]);
  useEffect(() => { setPicks([]); }, [mesh]); // 모델이 바뀌면 측정 초기화

  // 측정 표시: 점 + 두 점을 잇는 선 (항상 앞에 보이게)
  useEffect(() => {
    const g = marksRef.current;
    if (!g) return;
    g.children.forEach((c) => (c as THREE.Mesh).geometry.dispose());
    g.clear();
    const size = mesh ? new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(mesh.vertices, 3)).getSize(new THREE.Vector3()).length() : 50;
    for (const k of picks) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(size * 0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0xdc2626, depthTest: false }));
      dot.position.set(...k.p);
      dot.renderOrder = 10;
      g.add(dot);
    }
    if (picks.length === 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(picks.map((k) => new THREE.Vector3(...k.p)));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xdc2626, depthTest: false }));
      line.renderOrder = 10;
      g.add(line);
    }
  }, [picks, mesh]);

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
      s.sketches.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: on ? 0xf59e0b : 0x60a5fa, depthTest: !on })));
    }
  }, [doc, highlight]);

  const last = picks[picks.length - 1];
  const d = picks.length === 2 ? picks[1].p.map((v, i) => v - picks[0].p[i]) : undefined;
  const f3 = (v: number) => v.toFixed(3);
  return (
    <>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      <div className="view-tools">
        {([["등각", [0.8, -1, 0.7]], ["위", [0, 0, 1]], ["정면", [0, -1, 0]], ["오른쪽", [1, 0, 0]]] as const).map(([l, d]) => (
          <button key={l} onClick={() => sceneRef.current?.view([...d] as [number, number, number])}>{l}</button>
        ))}
        <button title="화면에 맞춤" onClick={() => sceneRef.current?.fit()}>맞춤</button>
      </div>
      {measure && (
        <div className="measure-box">
          <b>📏 측정</b>
          {picks.length === 0 && <div>바디 위의 점을 클릭하세요 (두 점 → 거리)</div>}
          {d && (
            <div>거리 <b>{f3(Math.hypot(d[0], d[1], d[2]))} mm</b>
              <br /><small>ΔX {f3(d[0])} · ΔY {f3(d[1])} · ΔZ {f3(d[2])}</small></div>
          )}
          {picks.length === 1 && <div>점 ({last.p.map(f3).join(", ")}) · 다음 점을 클릭하세요</div>}
          {last?.face && (
            <div><small>면: {FACE_KIND[last.face.kind] ?? last.face.kind} · 면적 {f3(last.face.area)} mm²</small></div>
          )}
        </div>
      )}
    </>
  );
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

const FACE_KIND: Record<string, string> = {
  PLANE: "평면", CYLINDRE: "원통면", CONE: "원뿔면", SPHERE: "구면", TORUS: "토러스면",
  BSPLINE_SURFACE: "자유곡면", BEZIER_SURFACE: "자유곡면", REVOLUTION_SURFACE: "회전면", EXTRUSION_SURFACE: "돌출면",
};
