import { Icon } from "../../shared/ui/Icon";

// M05 will bind its typed Floor[] to the stable pointId and reuse MapCanvas.
// Do not call a planned endpoint or invent floors before reviewed material arrives.
export function FloorPanel({
  pointId,
  pointName,
}: {
  pointId: string;
  pointName: string;
}) {
  return (
    <section
      className="floor-placeholder"
      data-point-id={pointId}
      aria-label={`${pointName}楼层结构`}
    >
      <span className="floor-icon">
        <Icon name="layers" size={26} />
      </span>
      <h3>楼层结构图待补充</h3>
      <p>这里将展示{pointName}的楼层平面图，便于查看房间与公共设施。</p>
      <span className="soft-label">暂无已发布楼层</span>
    </section>
  );
}
