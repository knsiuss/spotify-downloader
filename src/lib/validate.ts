// Validasi angka dari input eksternal (body API). NaN/Infinity/string "abc"
// harus berakhir di fallback atau di-clamp - bukan diam-diam menyebar ke engine.

/**
 * Parse angka dari unknown; kalau tidak finite kembalikan fallback, lalu clamp ke [min, max].
 * Dipakai untuk concurrency/retries/limit dari request body.
 */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const trimmed = typeof value === "string" ? value.trim() : value;
  const n =
    typeof trimmed === "number" ? trimmed
    : typeof trimmed === "string" && trimmed !== "" ? Number(trimmed)
    : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
