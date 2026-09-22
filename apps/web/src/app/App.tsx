import { useEffect, useState } from "react";
import { PointBrowser } from "../features/campus/PointBrowser";
import { api, type Campus } from "../shared/api/client";

export function App() {
  const [campus, setCampus] = useState<Campus | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    Promise.all([
      api.status(controller.signal),
      api.campuses(controller.signal),
    ])
      .then(([, result]) => {
        if (controller.signal.aborted) return;
        setCampus(
          result.data.find((item) => item.id === "nku-jinnan") ??
            result.data[0] ??
            null,
        );
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [retry]);

  return (
    <>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <header className="header">
        <a className="brand" href="/" aria-label="Twin NKU 首页">
          <span className="brand-mark" aria-hidden="true">
            N<span>·</span>
          </span>
          <span>
            Twin NKU<small>校园文化导览</small>
          </span>
        </a>
        <nav aria-label="主导航">
          <a href="#explore">
            探索校园 <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="hero-tag">
              <span /> 南开大学 · 津南校区
            </div>
            <h1 id="hero-title">
              遇见南开，
              <br />
              从好奇开始。
            </h1>
            <p>
              认识一处风景，读懂一段历史。
              <br />
              让每一次探索，都成为与校园的相遇。
            </p>
            <a className="primary-link" href="#explore">
              探索校园故事 <span aria-hidden="true">↗</span>
            </a>
            <div className="hero-caption">
              <span className="caption-line" /> 空间 · 记忆 · 故事
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-ring ring-one" />
            <div className="art-ring ring-two" />
            <div className="art-ring ring-three" />
            <div className="art-axis axis-one" />
            <div className="art-axis axis-two" />
            <span className="art-star star-one">✦</span>
            <span className="art-star star-two">✦</span>
            <div className="art-letter">N</div>
            <div className="art-label">
              NANKAI
              <br />
              <span>A PLACE TO DISCOVER</span>
            </div>
            <span className="art-coord">津南 · 与南开相遇</span>
          </div>
        </section>
        <div className="intro-strip">
          <span>一所大学，许多值得听的故事。</span>
          <span>
            从校园空间，走向校园文化 <span aria-hidden="true">↓</span>
          </span>
        </div>
        {state === "ready" && campus ? (
          <PointBrowser campusId={campus.id} />
        ) : (
          <section className="explore" id="explore" aria-live="polite">
            <div className="empty">
              <h2>
                {state === "loading"
                  ? "正在连接校园导览…"
                  : state === "error"
                    ? "暂时无法连接校园导览"
                    : "校园资料即将开放"}
              </h2>
              <p>
                {state === "error"
                  ? "请稍后重试，我们会保留你当前的页面。"
                  : "欢迎来到 Twin NKU。"}
              </p>
              {state === "error" && (
                <button
                  className="text-button"
                  onClick={() => setRetry((n) => n + 1)}
                >
                  重新连接
                </button>
              )}
            </div>
          </section>
        )}
      </main>
      <footer>
        <a className="footer-brand" href="/">
          Twin NKU<span>校园文化导览</span>
        </a>
        <p>让校园的故事，被更多人看见。</p>
        <span className="connection">
          <i className={state === "ready" ? "online" : ""} />
          {state === "ready"
            ? "服务已连接"
            : state === "loading"
              ? "连接中"
              : "连接暂不可用"}
        </span>
      </footer>
    </>
  );
}
