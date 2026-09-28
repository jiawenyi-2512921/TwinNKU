"use strict";
const channel = "twinnku:agent-frame:v1";
const instance = new URLSearchParams(location.hash.slice(1)).get("instance");
let context = "";
const tell = (type) => parent.postMessage({channel, instance, type}, location.origin);
const $ = (id) => document.getElementById(id);
// Every code the demo backend or the upstream probe can emit must appear here.
// An unmapped code falls through to the generic fallback, which makes three very
// different faults (session pool full, upstream gave no answer, transport broken)
// look identical to the user and leaves nothing to debug with.
const errors = {
  // --- session / demo access ---
  INVALID_DEMO_CODE: "演示口令不正确。",
  LOGIN_REQUIRED: "请输入演示口令，开始新的会话。",
  SESSION_LIMIT: "当前演示名额已满，请稍后再试；或刷新页面重新输入口令。",
  RATE_LIMITED: "请求较多，请稍后再试。",
  // --- request shape (normally impossible from this page) ---
  EMPTY_QUERY: "请先输入问题，再发送。",
  ORIGIN_REJECTED: "当前页面来源未经授权，演示入口只能在指定域名下使用。",
  JSON_REQUIRED: "请求格式不正确，请刷新页面后重试。",
  CONTENT_LENGTH_REQUIRED: "请求格式不正确，请刷新页面后重试。",
  BODY_TOO_LARGE: "请求内容过长，请缩短后再发送。",
  INCOMPLETE_BODY: "请求未完整送达，请重试。",
  NOT_FOUND: "演示接口不存在，请确认部署是否完整。",
  // --- request lifecycle / idempotency ---
  REQUEST_IN_PROGRESS: "上一条回答仍在生成，请稍候。",
  REQUEST_ID_REUSED: "本次请求与上一条内容不一致，请重新发送。",
  PREVIOUS_RESULT_UNKNOWN: "上一条请求结果无法确认，请先等待或开始新对话。",
  // --- upstream authentication / authorization ---
  SSO_REDIRECT: "学校 API 仍要求统一认证，请联系平台管理员开放应用 API。",
  REDIRECT_BLOCKED: "学校接口返回了异常跳转，已阻止跟随以保护凭据，请联系平台管理员。",
  AUTH_FAILED: "应用 API 密钥未通过验证。",
  ACCESS_DENIED: "学校平台拒绝了应用 API 请求。",
  ENDPOINT_NOT_FOUND: "学校接口地址不存在，请核实应用 API 的网关地址。",
  INVALID_KEY_FORMAT: "应用 API 密钥格式不正确，请核实后重新配置。",
  INVALID_ENDPOINT: "学校接口地址配置不正确，请核实后重新配置。",
  // --- upstream transport ---
  NETWORK_TIMEOUT: "学校服务响应超时，结果暂时无法确认。请勿重复发送同一问题。",
  NETWORK_ERROR: "服务器无法连接学校服务，请稍后再试。",
  TLS_ERROR: "与学校服务的安全连接失败，请联系平台管理员。",
  TRANSPORT_ERROR: "与学校服务的通信异常，请稍后再试。",
  // --- upstream payload ---
  NON_JSON_RESPONSE: "学校服务返回了非预期格式，请稍后再试。",
  INVALID_JSON: "学校服务返回的内容无法解析，请稍后再试。",
  UNEXPECTED_HTTP_STATUS: "学校服务返回了异常状态，请稍后再试。",
  RESPONSE_TOO_LARGE: "学校服务返回内容过大，已中止处理，请换个问法再试。",
  INVALID_RESPONSE_SHAPE: "学校服务返回结构异常，请稍后再试。",
  PLATFORM_ERROR: "学校平台报告了内部错误，请稍后再试。",
  INVALID_CONFIG_RESPONSE: "学校应用配置读取失败，请核实应用是否已发布。",
  INVALID_CONVERSATION_RESPONSE: "学校服务未能建立会话，请稍后再试。",
  NO_FINAL_ANSWER: "小开这次没有给出有效回答，请换个问法或稍后重试。",
  CONTEXT_NOT_CONFIRMED: "小开未能确认上文，请重新描述你的问题。"
};
function status(text) { $("status").textContent = text; }
async function post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const r = await fetch("/agent-demo/" + path, {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), signal:controller.signal});
    // A gateway error page is not JSON. Reading it defensively keeps us from
    // swallowing the real status inside a SyntaxError and losing all diagnostics.
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok) {
      const code = data && typeof data.code === "string" ? data.code : "";
      const e = new Error(errors[code] || `服务暂时不可用（错误码 ${r.status}），请稍后再试。`);
      e.code = code || "SERVICE_ERROR";
      throw e;
    }
    if (!data) throw new Error("服务返回了非预期格式，请稍后再试。");
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
