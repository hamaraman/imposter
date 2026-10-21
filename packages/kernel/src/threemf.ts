import type { Shape3D } from "replicad";

// 3MF 내보내기 (M3, 명세 F-20): 3MF = ZIP 안에 XML 메시. 3D 프린팅 슬라이서용
// 면마다 따로 나온 메시의 경계 정점을 좌표로 합쳐서 닫힌(watertight) 메시로 만든다
export function shapeTo3mf(shape: Shape3D): Uint8Array {
  const m = shape.mesh({ tolerance: 0.01, angularTolerance: 5 });
  const { vertices, triangles } = weld(m.vertices, m.triangles);

  const v: string[] = [];
  for (let i = 0; i < vertices.length; i += 3)
    v.push(`<vertex x="${num(vertices[i])}" y="${num(vertices[i + 1])}" z="${num(vertices[i + 2])}"/>`);
  const t: string[] = [];
  for (let i = 0; i < triangles.length; i += 3)
    t.push(`<triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`);

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">MyCAD</metadata>
<resources><object id="1" type="model"><mesh>
<vertices>${v.join("")}</vertices>
<triangles>${t.join("")}</triangles>
</mesh></object></resources>
<build><item objectid="1"/></build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const enc = new TextEncoder();
  return zipStore([
    ["[Content_Types].xml", enc.encode(contentTypes)],
    ["_rels/.rels", enc.encode(rels)],
    ["3D/3dmodel.model", enc.encode(model)],
  ]);
}

const num = (x: number) => (Math.round(x * 1e6) / 1e6).toString();

// 같은 좌표(1e-6mm 단위로 반올림)의 정점을 하나로 합치고, 넓이 0인 삼각형은 버림
export function weld(verts: number[], tris: number[]): { vertices: number[]; triangles: number[] } {
  const key = (i: number) => `${Math.round(verts[i * 3] * 1e6)},${Math.round(verts[i * 3 + 1] * 1e6)},${Math.round(verts[i * 3 + 2] * 1e6)}`;
  const map = new Map<string, number>();
  const remap: number[] = [];
  const vertices: number[] = [];
  for (let i = 0; i < verts.length / 3; i++) {
    const k = key(i);
    let j = map.get(k);
    if (j === undefined) { j = vertices.length / 3; map.set(k, j); vertices.push(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]); }
    remap.push(j);
  }
  const triangles: number[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [remap[tris[i]], remap[tris[i + 1]], remap[tris[i + 2]]];
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { vertices, triangles };
}

// 압축 없는(STORE) ZIP. 3MF 리더는 STORE를 모두 지원한다
function zipStore(files: [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    chunks.push(new Uint8Array(local.buffer), n, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, n.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(d: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
