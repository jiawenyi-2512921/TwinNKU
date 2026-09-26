import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import "./app/styles.css";

const AdminApp = lazy(() => import("./features/admin/AdminApp"));
const isAdmin =
  window.location.pathname === "/admin" ||
  window.location.pathname.startsWith("/admin/");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div role="status">正在加载…</div>}>
      {isAdmin ? <AdminApp /> : <App />}
    </Suspense>
  </React.StrictMode>,
);
