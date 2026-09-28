"use strict";
const channel = "twinnku:agent-frame:v1";
const instance = new URLSearchParams(location.hash.slice(1)).get("instance");
let context = "";
const tell = (type) => parent.postMessage({channel, instance, type}, location.origin);
const $ = (id) => document.getElementById(id);
const errors = {
  INVALID_DEMO_CODE: "演示口令不正确。", LOGIN_REQUIRED: "请输入演示口令，开始新的会话。",
  RATE_LIMITED: "请求较多，请稍后再试。", SSO_REDIRECT: "学校 API 仍要求统一认证，请联系平台管理员开放应用 API。",
  AUTH_FAILED: "应用 API 密钥未通过验证。", ACCESS_DENIED: "学校平台拒绝了应用 API 请求。",
  NETWORK_TIMEOUT: "学校服务响应超时，结果暂时无法确认。请勿重复发送同一问题。",
  PREVIOUS_RESULT_UNKNOWN: "上一条请求结果无法确认，请先等待或开始新对话。",
  REQUEST_IN_PROGRESS: "上一条回答仍在生成，请稍候。"
};
function status(text) { $("status").textContent = text; }
async function post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const r = await fetch("/agent-demo/" + path, {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), signal:controller.signal});
    const data = await r.json();
    if (!r.ok) { const e = new Error(errors[data.code] || "暂时无法取得回答，请稍后重试。"); e.code = data.code || "SERVICE_ERROR"; throw e; }
    return data;
  } catch(e) {
    if(e.code && e.name !== "AbortError") throw e;
    throw new Error("连接暂时中断，未能确认请求结果。请稍后再试，避免立即重复发送。");
  } finally { clearTimeout(timer); }
}
function bubble(text, role) {
  const p = document.createElement("p"); p.className = "message " + role; p.textContent = text;
  $("messages").append(p); p.scrollIntoView({block:"end", behavior:"smooth"});
}
window.addEventListener("message", (e) => {
  if(e.origin === location.origin && e.source === parent && e.data?.channel === channel && e.data?.instance === instance && e.data?.type === "initialize") {
    context = ["campus_name", "point_name", "floor_label"].map(key => {
      const value = e.data.context?.[key];
      return typeof value === "string" && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value) ? value : "";
    }).filter(Boolean).join(" · ");
    tell("initialized");
  }
});
tell("booted");
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  status("正在建立会话…");
  try { await post("login", {code:$("code").value}); $("code").value = ""; $("login").hidden = true; $("chat").hidden = false; status("可以开始提问了。"); $("query").focus(); }
  catch(e) { status(e.message); } finally { button.disabled = false; }
});
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const query = $("query").value.trim(); if(!query) return;
  $("send").disabled = true; $("reset").disabled = true; $("query").disabled = true;
  bubble(query,"user"); $("query").value = ""; status("小开正在思考，请稍候…");
  try { const data = await post("chat", {query, context, request_id:crypto.randomUUID()}); bubble(data.answer,"assistant"); status(""); }
  catch(e) { status(e.message); if(e.code === "LOGIN_REQUIRED") { $("login").hidden = false; $("chat").hidden = true; } }
  finally { $("send").disabled = false; $("reset").disabled = false; $("query").disabled = false; }
});
$("reset").addEventListener("click", () => { $("messages").replaceChildren(); $("chat").hidden = true; $("login").hidden = false; status("再次输入演示口令即可创建独立的新对话。"); });
