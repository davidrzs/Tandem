import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Link } from "react-router-dom";
import { LiveSection, type LiveSectionQuery } from "@tandem/editor";
import type { RouterOutputs } from "@tandem/server/trpc";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";

type Section = RouterOutputs["documents"]["liveSection"];
type Task = Extract<Section, { tasks: unknown }>["tasks"][number];

export const LIVE_SECTION_LABELS: Record<LiveSectionQuery, string> = {
  open_from_last_time: "Open from last time",
  since_last_meeting: "Since last meeting",
  open_tasks_here: "Open tasks under this page",
};

function TaskList({ tasks, empty }: { tasks: Task[]; empty: string }) {
  if (tasks.length === 0) return <p className="live-section-empty">{empty}</p>;
  return (
    <ul className="live-section-tasks">
      {tasks.map((task) => (
        <li key={`${task.documentId}:${task.blockId}`} className={task.done ? "done" : ""}>
          <span className="todo-box" aria-hidden="true" />
          <Link to={`/d/${task.documentId}`}>{task.text || "Untitled task"}</Link>
          <span className="live-section-from">{task.documentTitle || "Untitled"}</span>
        </li>
      ))}
    </ul>
  );
}

function Body({ section }: { section: Section }) {
  if (section.query === "open_tasks_here") {
    return <TaskList tasks={section.tasks} empty="Nothing open under this page." />;
  }
  if (!section.source) {
    return <p className="live-section-empty">No earlier page of this type sits beside this one.</p>;
  }
  const from = (
    <p className="live-section-source">
      From <Link to={`/d/${section.source.id}`}>{section.source.title || "Untitled"}</Link>
      {section.query === "since_last_meeting" && section.scope && (
        <>
          {" "}in <Link to={`/d/${section.scope.id}`}>{section.scope.title || "Untitled"}</Link>
        </>
      )}
    </p>
  );
  if (section.query === "open_from_last_time") {
    return (
      <>
        {from}
        <TaskList tasks={section.tasks} empty="Everything from last time is done." />
      </>
    );
  }
  const { pagesUpdated, tasksClosed, tasksAdded } = section.changes;
  return (
    <>
      {from}
      <h4>Pages updated</h4>
      {pagesUpdated.length === 0 ? (
        <p className="live-section-empty">No pages changed.</p>
      ) : (
        <ul className="live-section-pages">
          {pagesUpdated.map((page) => (
            <li key={page.id}>
              <Link to={`/d/${page.id}`}>{page.title || "Untitled"}</Link>
            </li>
          ))}
        </ul>
      )}
      <h4>Tasks closed</h4>
      <TaskList tasks={tasksClosed} empty="No tasks closed." />
      <h4>Tasks added</h4>
      <TaskList tasks={tasksAdded} empty="No tasks added." />
    </>
  );
}

/** A read-only list resolved from this page every time it renders. */
function LiveSectionView({ node, extension, selected }: NodeViewProps) {
  const query = node.attrs.query as LiveSectionQuery;
  const documentId = extension.options.documentId as string;
  const section = trpc.documents.liveSection.useQuery({ id: documentId, query }, { enabled: !!documentId });
  return (
    <NodeViewWrapper
      className={"live-section" + (selected ? " selected" : "")}
      contentEditable={false}
      data-live-section={query}
    >
      <div className="live-section-head">
        <Icon name="check" size={12} />
        {LIVE_SECTION_LABELS[query]}
      </div>
      {section.data ? (
        <Body section={section.data} />
      ) : (
        <p className="live-section-empty">{section.error ? "Couldn't load this section." : "Loading…"}</p>
      )}
    </NodeViewWrapper>
  );
}

/** The shared live section node, resolved against `documentId` in the editor. */
export const ClientLiveSection = LiveSection.extend<{ documentId: string }>({
  addOptions() {
    return { documentId: "" };
  },
  addNodeView() {
    return ReactNodeViewRenderer(LiveSectionView);
  },
});
