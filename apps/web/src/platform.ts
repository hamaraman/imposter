// 웹과 데스크톱(Tauri)의 파일 입출력 차이를 여기서 흡수한다
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function saveFile(name: string, data: Uint8Array | string, ext: string): Promise<boolean> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return false; // 사용자가 취소
    await writeFile(path, bytes);
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export async function openTextFile(ext: string): Promise<string | undefined> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    return typeof path === "string" ? readTextFile(path) : undefined;
  }
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: `.${ext}` });
    input.onchange = () => (input.files?.[0] ? input.files[0].text().then(resolve) : resolve(undefined));
    input.click();
  });
}
