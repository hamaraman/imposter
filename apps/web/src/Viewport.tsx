import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MeshData } from "@my-cad/kernel/src/build";

// 명세 F-02: 궤도/이동/확대 뷰포트. CAD 관례대로 Z축이 위
export function Viewport({ mesh }: { mesh?: MeshData }) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{ scene: THREE.Scene; group: THREE.Group; fit: () => void }>();

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
    scene.add(group);

    const fit = () => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const c = box.getCenter(new THREE.Vector3());
      const r = box.getSize(new THREE.Vector3()).length();
      controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(0.8, -1, 0.7).normalize().multiplyScalar(r * 1.6));
    };
    sceneRef.current = { scene, group, fit };

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

  return <div ref={host} style={{ position: "absolute", inset: 0 }} />;
}
