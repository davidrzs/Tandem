import type { SVGProps } from "react";

/** Hand-drawn 16px stroke icon set — one visual voice for every control. */

const PATHS = {
  plus: "M8 3.5v9M3.5 8h9",
  search: "M12.9 12.9 10.2 10.2M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z",
  home: "M3 7.2 8 3l5 4.2V13a.7.7 0 0 1-.7.7H9.8V10H6.2v3.7H3.7a.7.7 0 0 1-.7-.7V7.2Z",
  users:
    "M11 13v-1.2a2.3 2.3 0 0 0-2.3-2.3H4.3A2.3 2.3 0 0 0 2 11.8V13M6.5 7.2a2.35 2.35 0 1 0 0-4.7 2.35 2.35 0 0 0 0 4.7ZM14 13v-1.2a2.3 2.3 0 0 0-1.7-2.2M10.3 2.6a2.35 2.35 0 0 1 0 4.55",
  dots: "M4 8h.01M8 8h.01M12 8h.01",
  chevron: "M6 4l4 4-4 4",
  archive: "M2.5 5h11M3.5 5v7.3a.7.7 0 0 0 .7.7h7.6a.7.7 0 0 0 .7-.7V5M6.5 7.8h3M3 3h10a.5.5 0 0 1 .5.5V5h-11V3.5A.5.5 0 0 1 3 3Z",
  trash:
    "M3 4.5h10M6.5 4.5V3.3a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8v1.2M5 4.5l.5 8a.8.8 0 0 0 .8.7h3.4a.8.8 0 0 0 .8-.7l.5-8",
  restore: "M3 7a5 5 0 1 1 1.5 3.6M3 7V3.8M3 7h3.2",
  close: "M4 4l8 8M12 4l-8 8",
  check: "M3.5 8.5 6.5 11.5 12.5 4.5",
  signout: "M6 13H3.7a.7.7 0 0 1-.7-.7V3.7a.7.7 0 0 1 .7-.7H6M10.5 10.8 13.3 8l-2.8-2.8M13 8H6.5",
  pen: "M9.7 3.3l3 3L6 13H3v-3l6.7-6.7ZM8.5 4.5l3 3",
  share: "M8 10V2.8M5.3 5 8 2.5 10.7 5M3.5 8v4.3a.7.7 0 0 0 .7.7h7.6a.7.7 0 0 0 .7-.7V8",
  page: "M9.5 2.5H4.7a.7.7 0 0 0-.7.7v9.6a.7.7 0 0 0 .7.7h6.6a.7.7 0 0 0 .7-.7V5L9.5 2.5ZM9.5 2.5V5H12M6 8h4M6 10.5h4",
  comment:
    "M13.5 7.8a5.3 5.3 0 0 1-5.5 5.1c-.8 0-1.6-.15-2.3-.45L2.5 13.3l.75-2.6a5.05 5.05 0 0 1-.75-2.9A5.3 5.3 0 0 1 8 2.7a5.3 5.3 0 0 1 5.5 5.1Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
