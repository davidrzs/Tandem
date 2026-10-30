import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LiveSection, markdownToJSON, type LiveSectionQuery } from "@tandem/editor";
import type { RouterOutputs } from "@tandem/server/trpc";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { formatValue } from "./properties.js";
import { ReadOnlyDoc } from "./ReadOnlyDoc.js";

type Section = RouterOutputs["documents"]["liveSection"];
type Task = Extract<Section, { tasks: unknown }>["tasks"][number];
type SeriesEntry = RouterOutputs["documents"]["meetingSeries"]["entries"][number];

export const LIVE_SECTION_LABELS: Record<LiveSectionQuery, string> = {
  open_from_last_time: "Open from last time",
  since_last_meeting: "Since last meeting",
  open_tasks_here: "Open tasks under this page",
  meeting_series: "Meeting series",
};

/** How many more meetings "Show older" reveals. */
const SERIES_PAGE = 10;

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

function ListSection({ documentId, query }: { documentId: string; query: Exclude<LiveSectionQuery, "meeting_series"> }) {
  const section = trpc.documents.liveSection.useQuery({ id: documentId, query }, { enabled: !!documentId });
  if (section.data) return <Body section={section.data} />;
  return <p className="live-section-empty">{section.error ? "Couldn't load this section." : <span className="shimmer">Loading…</span>}</p>;
}

/** A live section inside a series entry: a link to the page that holds it,
 * never resolved, so a series can't nest. */
function SectionLink({ node, extension }: NodeViewProps) {
  return (
    <NodeViewWrapper className="live-section-link" contentEditable={false}>
      <Link to={`/d/${extension.options.documentId as string}`}>
        {LIVE_SECTION_LABELS[node.attrs.query as LiveSectionQuery]}
      </Link>
    </NodeViewWrapper>
  );
}

const SectionLinkNode = LiveSection.extend<{ documentId: string }>({
  addOptions() {
    return { documentId: "" };
  },
  addNodeView() {
    return ReactNodeViewRenderer(SectionLink);
  },
});

function SeriesItem({ entry }: { entry: SeriesEntry }) {
  const content = useMemo(() => markdownToJSON(entry.markdown), [entry.markdown]);
  const sectionLink = useMemo(() => SectionLinkNode.configure({ documentId: entry.id }), [entry.id]);
  return (
    <article className="series-entry">
      <header className="series-entry-head">
        <h3>{entry.title || "Untitled"}</h3>
        {entry.date && (
          <span className="series-entry-meta">
            {formatValue({ kind: entry.date.length === 10 ? "date" : "datetime", options: [] }, entry.date)}
          </span>
        )}
        {entry.attendees.length > 0 && (
          <span className="series-entry-meta">
            {entry.attendees.map((person, i) => (
              <span key={person.id}>
                {i > 0 && ", "}
                <Link to={`/d/${person.id}`}>{person.title || "Untitled"}</Link>
              </span>
            ))}
          </span>
        )}
        <Link className="series-entry-open" to={`/d/${entry.id}`}>
          Open
        </Link>
      </header>
      <ReadOnlyDoc contentJson={content} liveSection={sectionLink} />
    </article>
  );
}

/** The pages under this one, newest first, each with its whole body. */
function SeriesSection({ documentId }: { documentId: string }) {
  const [limit, setLimit] = useState(SERIES_PAGE);
  const series = trpc.documents.meetingSeries.useQuery(
    { id: documentId, limit },
    { enabled: !!documentId, placeholderData: (prev) => prev },
  );
  if (!series.data) {
    return <p className="live-section-empty">{series.error ? "Couldn't load this section." : <span className="shimmer">Loading…</span>}</p>;
  }
  const { entries, total } = series.data;
  if (entries.length === 0) return <p className="live-section-empty">No meetings under this page yet.</p>;
  return (
    <>
      {entries.map((entry) => (
        <SeriesItem key={entry.id} entry={entry} />
      ))}
      {total > entries.length && (
        <button type="button" className="btn series-older" onClick={() => setLimit(entries.length + SERIES_PAGE)}>
          Show older ({total - entries.length})
        </button>
      )}
    </>
  );
}

/** A read-only view resolved from this page every time it renders. */
function LiveSectionView({ node, extension, selected }: NodeViewProps) {
  const query = node.attrs.query as LiveSectionQuery;
  const documentId = extension.options.documentId as string;
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
      {query === "meeting_series" ? (
        <SeriesSection documentId={documentId} />
      ) : (
        <ListSection documentId={documentId} query={query} />
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
