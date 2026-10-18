import { Modal } from "./Modal.js";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";
const ALT = IS_MAC ? "⌥" : "Alt";
const SHIFT = IS_MAC ? "⇧" : "Shift";
// The sidebar's keyboard move is Control+Shift+D on every platform.
const CTRL = IS_MAC ? "⌃" : "Ctrl";

/** Only bindings that exist: app-level ones in App.tsx/Editor.tsx, the
 * sidebar tree's in useSidebarTree.ts, the rest are TipTap
 * StarterKit/TaskList/Collaboration defaults and our input rules. */
const GROUPS: { title: string; rows: [keys: string[], label: string][] }[] = [
  {
    title: "General",
    rows: [
      [[MOD, "K"], "Search"],
      [["?"], "Keyboard shortcuts"],
      [[MOD, "F"], "Find in document"],
      [[MOD, "Enter"], "Send comment"],
    ],
  },
  {
    title: "Sidebar",
    rows: [
      [["↑", "↓"], "Move between rows"],
      [["←", "→"], "Fold or unfold"],
      [["Enter"], "Open or toggle"],
      [[CTRL, SHIFT, "D"], "Move a document (↑↓ to place, Enter to drop)"],
      [[SHIFT, "F10"], "Row menu"],
    ],
  },
  {
    title: "Editing",
    rows: [
      [["/"], "Insert block"],
      [["@"], "Mention a person or link a page"],
      [[MOD, "Z"], "Undo"],
      [[MOD, SHIFT, "Z"], "Redo"],
      [[SHIFT, "Enter"], "Line break"],
    ],
  },
  {
    title: "Formatting",
    rows: [
      [[MOD, "B"], "Bold"],
      [[MOD, "I"], "Italic"],
      [[MOD, SHIFT, "S"], "Strikethrough"],
      [[MOD, "E"], "Inline code"],
      [[MOD, ALT, "1–3"], "Heading 1–3"],
      [[MOD, SHIFT, "8"], "Bullet list"],
      [[MOD, SHIFT, "7"], "Numbered list"],
      [[MOD, SHIFT, "9"], "To-do list"],
      [[MOD, SHIFT, "B"], "Quote"],
    ],
  },
  {
    title: "Markdown",
    rows: [
      [["#", "Space"], "Heading (## for level 2…)"],
      [["-", "Space"], "Bullet list"],
      [["1.", "Space"], "Numbered list"],
      [["[ ]", "Space"], "To-do"],
      [[">", "Space"], "Quote"],
      [["```", "Space"], "Code block"],
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="shortcuts">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.rows.map(([keys, label]) => (
                <div key={label} className="shortcut-row">
                  <dt>{label}</dt>
                  <dd>
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
