export type IntroductionSource = { title: string; url: string | null };
export type Introduction = {
  paragraphs: string[];
  sources: IntroductionSource[];
  checkedOn: string | null;
};

// A small, explicit footer format in the existing summary field. This is not
// a general Markdown/HTML renderer; unrecognised content remains plain text.
export function parseIntroduction(summary: string): Introduction {
  const plain = (text: string): Introduction => ({
    paragraphs: text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean),
    sources: [],
    checkedOn: null,
  });
  const marker = "\n\n资料来源：\n";
  const text = summary.replace(/\r\n/g, "\n").trim();
  const index = text.lastIndexOf(marker);
  if (index < 1) return plain(text);
  const lines = text.slice(index + marker.length).split("\n");
  const date = /^资料核对：(\d{4}-\d{2}-\d{2})$/.exec(lines.pop() || "");
  if (!date || lines.length < 1 || lines.length > 8) return plain(text);
  const parsedDate = new Date(date[1] + "T00:00:00Z");
  if (
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date[1]
  )
    return plain(text);
  const sources: IntroductionSource[] = [];
  for (const line of lines) {
    const link = /^\[([^\[\]<>]+)\]\(([^\s\\()<>]+)\)$/.exec(line);
    if (link) {
      try {
        const url = new URL(link[2]);
        if (
          url.protocol !== "https:" ||
          !url.hostname ||
          url.username ||
          url.password
        )
          return plain(text);
        sources.push({ title: link[1], url: url.href });
      } catch {
        return plain(text);
      }
    } else if (line.trim() && !/[\[\]<>]/.test(line)) {
      sources.push({ title: line, url: null });
    } else {
      return plain(text);
    }
  }
  return { ...plain(text.slice(0, index)), sources, checkedOn: date[1] };
}
