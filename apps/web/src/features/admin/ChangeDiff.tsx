export type Difference = { label: string; before: string; after: string };

export function ChangeDiff({ rows }: { rows: Difference[] }) {
  const changed = rows.filter((row) => row.before !== row.after);
  return (
    <section className="ad-change-diff" aria-label="修改前后对照">
      <div className="ad-card-heading">
        <h3>本次修改</h3>
        <span className="ad-badge draft">{changed.length} 项变化</span>
      </div>
      {changed.length ? (
        <div className="ad-diff-table">
          <div className="ad-diff-labels">
            <span>项目</span>
            <span>当前正式内容</span>
            <span>本次提交内容</span>
          </div>
          {changed.map((row) => (
            <div className="ad-diff-row" key={row.label}>
              <strong>{row.label}</strong>
              <p>{row.before || "尚无内容"}</p>
              <p>{row.after || "移除内容"}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="ad-hint">
          文字字段没有变化，请继续核对位置、原图和本次资料依据。
        </p>
      )}
    </section>
  );
}
