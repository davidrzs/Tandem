import type { SuggestionOptions } from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";
import tippy, { type Instance } from "tippy.js";

/** Keyboard-navigable popup list shared by the slash menu and @-mentions. */

interface MenuProps<T> {
  items: T[];
  command: (item: T) => void;
  renderItem: (item: T) => ReactNode;
  itemKey: (item: T) => string;
}

export interface MenuHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

const SuggestionMenu = forwardRef(function SuggestionMenu<T>(
  { items, command, renderItem, itemKey }: MenuProps<T>,
  ref: ForwardedRef<MenuHandle>,
) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      // No matches: let the editor handle the key (don't trap Enter/arrows).
      if (items.length === 0) return false;
      if (e.key === "ArrowUp") {
        setSelected((s) => (s + items.length - 1) % items.length);
        return true;
      }
      if (e.key === "ArrowDown") {
        setSelected((s) => (s + 1) % items.length);
        return true;
      }
      if (e.key === "Enter") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) return <div className="slash-menu">No matches</div>;
  return (
    <div className="slash-menu">
      {items.map((item, i) => (
        <button
          key={itemKey(item)}
          className={"slash-item" + (i === selected ? " selected" : "")}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
        >
          {renderItem(item)}
        </button>
      ))}
    </div>
  );
});

/** The tippy + ReactRenderer plumbing every suggestion popup needs. */
export function suggestionRender<T>(
  renderItem: (item: T) => ReactNode,
  itemKey: (item: T) => string,
): SuggestionOptions["render"] {
  return () => {
    let component: ReactRenderer<MenuHandle, MenuProps<T>>;
    let popup: Instance;
    return {
      onStart: (props) => {
        // forwardRef erases the generic; the props type is enforced here.
        component = new ReactRenderer<MenuHandle, MenuProps<T>>(
          SuggestionMenu as React.ForwardRefExoticComponent<MenuProps<T>>,
          {
            props: {
              items: props.items as T[],
              command: props.command,
              renderItem,
              itemKey,
            },
            editor: props.editor,
          },
        );
        if (!props.clientRect) return;
        popup = tippy(document.body, {
          getReferenceClientRect: props.clientRect as () => DOMRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: "manual",
          placement: "bottom-start",
        });
      },
      onUpdate: (props) => {
        component.updateProps({ items: props.items as T[], command: props.command });
        if (props.clientRect) {
          popup?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect });
        }
      },
      onKeyDown: (props) => {
        if (props.event.key === "Escape") {
          popup?.hide();
          return true;
        }
        return component.ref?.onKeyDown(props.event) ?? false;
      },
      onExit: () => {
        popup?.destroy();
        component?.destroy();
      },
    };
  };
}
