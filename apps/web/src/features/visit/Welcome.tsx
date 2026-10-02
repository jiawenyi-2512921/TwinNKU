import type { Experience } from "../experiences/types";
import { safeMediaUrl } from "../experiences/progress";
import type { VisitMode } from "./session";
import "./welcome.css";

export function Welcome({
  items,
  campusName,
  onExplore,
  onTours,
}: {
  items: Experience[];
  campusName: string;
  onExplore: () => void;
  onTours: (mode: VisitMode, id?: string) => void;
}) {
  const images = items.filter(
    (item) =>
      item.content.kind === "media" && item.content.media_type === "image",
  );
  const hero = images.find((item) => safeMediaUrl(item.media_url));
  const routes = items.filter((item) => item.content.kind === "tour");
  const photo = hero && safeMediaUrl(hero.media_url);
  return (
    <section className="welcome" aria-label="南开校园文化展馆">
      <div className={`welcome-hero ${photo ? "with-photo" : ""}`}>
        {photo && (
          <img src={photo} alt={hero!.content.title} fetchPriority="high" />
        )}
        <div className="welcome-intro">
          <span className="welcome-eyebrow">南开 · 校园文化展馆</span>
          <h1>
            走近一个地点
            <br />
            理解一段南开故事
          </h1>
          <p>从校园地图出发，在影像、楼层与全景之间，找到属于你的参观节奏。</p>
          <button onClick={onExplore}>
            打开校园地图 <span aria-hidden="true">↗</span>
          </button>
          <small>{campusName}</small>
        </div>
      </div>
      <nav className="welcome-entries" aria-label="选择参观方式">
        <button onClick={() => onTours("online")}>
          <span>01 / 在线云游</span>
          <strong>让故事带你出发</strong>
          <p>沿主题路线，查看影像与 VR，听小开讲解。</p>
          <b aria-hidden="true">→</b>
        </button>
        <button onClick={() => onTours("onsite")}>
          <span>02 / 到校参观</span>
          <strong>把校园握在手中</strong>
          <p>手动选择位置，查看路线与下一站。</p>
          <b aria-hidden="true">→</b>
        </button>
        <button onClick={onExplore}>
          <span>03 / 自由探索</span>
          <strong>循着好奇心发现</strong>
          <p>在地图、地点目录与 VR 全景间自由查看。</p>
          <b aria-hidden="true">→</b>
        </button>
      </nav>
      <section className="welcome-routes" aria-label="已发布主题路线">
        <div>
          <span className="welcome-eyebrow">一次参观，一个视角</span>
          <h2>选择你的校园故事</h2>
        </div>
        {routes.length ? (
          <div className="welcome-route-grid">
            {routes.map((item) => {
              if (item.content.kind !== "tour") return null;
              const content = item.content;
              const cover = images.find(
                (image) =>
                  image.id === content.cover_image_id &&
                  image.revision === content.cover_image_revision,
              );
              const url = cover && safeMediaUrl(cover.media_url);
              return (
                <button
                  className="welcome-route"
                  key={item.id}
                  onClick={() => onTours("online", item.id)}
                >
                  {url ? (
                    <img src={url} alt="" loading="lazy" />
                  ) : (
                    <div className="welcome-route-text" aria-hidden="true">
                      南开
                      <br />
                      校园故事
                    </div>
                  )}
                  <span>{item.content.stops.length} 个站点</span>
                  <h3>{item.content.title}</h3>
                  <p>{item.content.description}</p>
                  <b>开始参观 →</b>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="welcome-empty">
            主题路线正在准备。你可以先通过校园地图和 VR 全景自由探索。
          </p>
        )}
      </section>
    </section>
  );
}
