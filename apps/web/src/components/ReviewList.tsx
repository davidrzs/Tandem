/** What an import or export couldn't carry over, folded under a count. */
export function ReviewList({ warnings }: { warnings: string[] }) {
  const unique = [...new Set(warnings)];
  if (unique.length === 0) return null;
  return (
    <details>
      <summary>
        {unique.length} thing{unique.length === 1 ? "" : "s"} to review
      </summary>
      <ul>
        {unique.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </details>
  );
}
