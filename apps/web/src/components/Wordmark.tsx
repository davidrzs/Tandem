/** The instance's name with its letter tile, as on the sidebar's workspace button. */
export function Wordmark({ name = "Tandem" }: { name?: string }) {
  return (
    <div className="wordmark">
      <span className="wordmark-mark" aria-hidden="true">
        {name.trim().slice(0, 1).toUpperCase() || "T"}
      </span>
      {name}
    </div>
  );
}
