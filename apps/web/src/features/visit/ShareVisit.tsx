import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { visitLink, type VisitSession } from "./session";

export function ShareVisit({ session }: { session: VisitSession }) {
  const [open, setOpen] = useState(false),
    [image, setImage] = useState<{ link: string; url: string } | null>(null),
    [notice, setNotice] = useState("");
  const link = visitLink(window.location.href, session);
  useEffect(() => {
    if (!open) return;
    setNotice("");
    let disposed = false;
    QRCode.toDataURL(link, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#55285e", light: "#ffffff" },
    })
      .then((url) => {
        if (!disposed) setImage({ link, url });
      })
      .catch(() => {
        if (!disposed) setNotice("二维码暂未生成，仍可复制链接。");
      });
    return () => {
      disposed = true;
    };
  }, [open, link]);
  return (
    <div className="visit-share">
      <button onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        在手机继续
      </button>
      {open && (
        <section aria-label="接续当前参观位置">
          {image?.link === link && (
            <img
              src={image.url}
              alt="扫码接续当前路线与站点"
              width={240}
              height={240}
            />
          )}
          <p>接续当前站点。新设备打开后，点击继续参观；讲解不会自动播放。</p>
          <input
            aria-label="参观接续链接"
            value={link}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setNotice("链接已复制");
              } catch {
                setNotice("请选中上方链接手动复制。");
              }
            }}
          >
            复制链接
          </button>
          {notice && <small role="status">{notice}</small>}
        </section>
      )}
    </div>
  );
}
