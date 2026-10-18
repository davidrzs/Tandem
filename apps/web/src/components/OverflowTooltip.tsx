import * as Tooltip from "@radix-ui/react-tooltip";
import { useRef, useState, type ReactElement } from "react";

/** Shows `text` in a tooltip only while `children` (one truncating element) is
 * obscured, by an ellipsis or by the row's overlaid actions. The child itself is
 * the trigger, so its classes and text stay what e2e selectors expect. A native
 * `title` would collide with the `getByTitle` selectors on row buttons. */
export function OverflowTooltip({ text, children }: { text: string; children: ReactElement }) {
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Root open={open} onOpenChange={(o) => setOpen(o && isObscured(ref.current))}>
      <Tooltip.Trigger asChild ref={(el) => (ref.current = el)}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side="right" sideOffset={10} collisionPadding={8}>
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Titles are flex:1, so the element's box always reaches under the actions;
 * measure the text itself. */
function isObscured(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.scrollWidth > el.clientWidth + 1) return true;
  const actions = el.closest(".tree-row")?.querySelector(".row-actions");
  if (!actions || getComputedStyle(actions).visibility !== "visible") return false;
  const text = document.createRange();
  text.selectNodeContents(el);
  return text.getBoundingClientRect().right > actions.getBoundingClientRect().left;
}
