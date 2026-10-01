import { parseIntroduction } from "./introduction";

export function PointIntroduction({ summary }: { summary: string }) {
  const content = parseIntroduction(summary);
  return (
    <div className="point-introduction">
      {content.paragraphs.length ? (
        content.paragraphs.map((paragraph, index) => (
          <p className="point-summary" key={index}>
            {paragraph}
          </p>
        ))
      ) : (
        <p className="point-summary">
          已在地图上为你标出这个地点。详细介绍将随校园资料逐步补充。
        </p>
      )}
      {content.sources.length > 0 && (
        <details className="introduction-sources">
          <summary>资料来源与核对日期</summary>
          <ul>
            {content.sources.map((source, index) => (
              <li key={index}>
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.title}
                    <span className="sr-only">（在新标签页打开）</span>
                  </a>
                ) : (
                  source.title
                )}
              </li>
            ))}
          </ul>
          <p>
            资料核对：
            <time dateTime={content.checkedOn || undefined}>
              {content.checkedOn}
            </time>
          </p>
        </details>
      )}
    </div>
  );
}
