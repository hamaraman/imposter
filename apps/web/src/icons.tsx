// 직접 그린 단순 선 아이콘 (24×24, stroke). 외부 아이콘 라이브러리를 쓰지 않음
const PATHS = {
  open: "M3 7h6l2 2h10v10H3z",
  save: "M5 3h11l3 3v15H5z M8 3v5h8V3 M8 21v-7h8v7",
  undo: "M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-4",
  redo: "M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h4",
  sketch: "M4 20l4-1L19 8l-3-3L5 16z M14 7l3 3",
  extrude: "M4 15l8 4 8-4-8-4z M12 11V3 M9 6l3-3 3 3",
  revolve: "M12 2v20 M8 6c-4 1-4 11 0 12 M16 6c4 1 4 11 0 12 M5.5 16.5L8 18l-1 2.5",
  shell: "M4 8l8-4 8 4v9l-8 4-8-4z M8 10v6l4 2 4-2v-6",
  hole: "M12 4a8 8 0 1 0 0.01 0z M12 9a3 3 0 1 0 0.01 0z",
  pattern: "M3 9h5v6H3z M10 9h5v6h-5z M17 9h4v6h-4z",
  mirror: "M12 3v18 M9 6L4 12l5 6z M15 6l5 6-5 6z",
  measure: "M3 17L17 3l4 4L7 21z M7 13l2 2 M10 10l2 2 M13 7l2 2",
  export: "M12 3v12 M7 10l5 5 5-5 M4 21h16",
  fillet: "M4 20V11a7 7 0 0 1 7-7h9",
  box: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
  chevron: "M6 9l6 6 6-6",
  params: "M4 6h16 M4 12h16 M4 18h16 M8 4v4 M16 10v4 M10 16v4",
  props: "M4 4h16v16H4z M4 9h16 M9 9v11",
  inspect: "M11 4a7 7 0 1 0 0.01 0z M16 16l5 5",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0.01 0z",
  eyeOff: "M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.7 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4.4-1",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14",
  edit: "M4 20l4-1L19 8l-3-3L5 16z",
  fit: "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5",
  rollback: "M6 4v16 M10 12l8-6v12z",
  warn: "M12 3l10 18H2z M12 10v5 M12 18v0.01",
  plane: "M3 15l6-8h12l-6 8z",
  face: "M4 7l8-4 8 4-8 4z M4 7v10l8 4 M12 11v10",
  check: "M5 12l5 5 9-11",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export const FEATURE_ICON: Record<string, IconName> = {
  sketch: "sketch", extrude: "extrude", revolve: "revolve", shell: "shell", sketchHole: "hole", hole: "hole",
  pattern: "pattern", mirror: "mirror", fillet: "fillet", box: "box",
};
