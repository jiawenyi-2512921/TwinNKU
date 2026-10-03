import type { ReactNode } from "react";
import type { Experience, TourMainView } from "../experiences/types";
import { TourResourceView } from "../experiences/ExperiencePanel";

/** Keep the same map instance while a published visual occupies the stage. */
export function SceneStage({
  view,
  pointId,
  items,
  map,
  onMap,
  expanded = false,
  onExpand,
  active = true,
  onMediaActiveChange,
}: {
  view: TourMainView;
  pointId: string;
  items: Experience[];
  map: ReactNode;
  onMap: () => void;
  expanded?: boolean;
  onExpand?: () => void;
  active?: boolean;
  onMediaActiveChange?: (active: boolean) => void;
}) {
  const visual = view.type !== "map";
  return (
    <div
      className={`scene-stage ${visual ? "has-visual" : "has-map"}`}
      aria-label="当前段落主画面"
    >
      {onExpand && (
        <button
          className="scene-expand"
          aria-expanded={expanded}
          onClick={onExpand}
        >
          {expanded ? "恢复图文布局" : "展开主画面"}
        </button>
      )}
      <div className="scene-map" hidden={visual}>
        {map}
      </div>
      {visual && (
        <section className="scene-visual">
          <TourResourceView
            resource={view}
            pointId={pointId}
            items={items}
            active={active}
            onMediaActiveChange={onMediaActiveChange}
          />
          <button className="scene-map-return" onClick={onMap}>
            在校园地图定位本站
          </button>
        </section>
      )}
    </div>
  );
}
