import type { ListedNode } from "./core/tree";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Line for `ls`: type, mode, size, path. */
export function formatNode(n: ListedNode): string {
  const t = n.type === "dir" ? "d" : n.type === "symlink" ? "l" : "-";
  const mode = (n.mode & 0o7777).toString(8).padStart(4, "0");
  return `${t} ${mode} ${formatBytes(n.size ?? 0).padStart(9)}  ${n.path}${n.type === "dir" ? "/" : ""}${n.target ? " -> " + n.target : ""}`;
}
