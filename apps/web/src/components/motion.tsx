const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

/** True when exit animations won't run (the stylesheet switches them off), so
 * callers must finish immediately instead of waiting for `animationend`. */
export const prefersReducedMotion = (): boolean => reduce.matches;

/** A count whose digits roll to each new value. Every place keeps its column
 * across renders (keyed from the units up), so 9 → 10 rolls the units and adds
 * a tens column rather than remounting everything. Mounts still, no roll.
 * The value is announced through an inline labelled wrapper: an sr-only
 * sibling or a label on the flex box itself gets padded with spaces in the
 * surrounding accessible name ("Comments ( 2 )"). */
export function RollingNumber({ value }: { value: number }) {
  const digits = String(value).split("");
  return (
    <span role="img" aria-label={String(value)}>
      <span className="roll" aria-hidden="true">
        {digits.map((d, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the key is the digit's place value, which is exactly the identity a rolling column needs
            key={digits.length - i}
            className="roll-strip"
            style={{ transform: `translateY(${-Number(d) * 10}%)` }}
          >
            {"0123456789".split("").map((n) => (
              <span key={n}>{n}</span>
            ))}
          </span>
        ))}
      </span>
    </span>
  );
}
