import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

function compile(file) {
  return ts.transpileModule(
    readFileSync(new URL(file, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
}
const helpers = {};
vm.runInNewContext(compile("../src/features/admin/webauthn.ts"), {
  exports: helpers,
  atob,
  btoa,
  Uint8Array,
  DOMException,
  Error,
});
const bytes = (n) => new Uint8Array([n, 128, 255]).buffer;
const pending = {
  status: "mfa_required",
  csrf_token: "pending-csrf",
  expires_at: "2026-10-02T00:05:00Z",
  must_change_password: false,
};
const session = {
  user: { id: "staff", role: "admin" },
  csrf_token: "verified-csrf",
  mfa_verified: true,
};
const options = {
  challenge: helpers.encodeBase64url(bytes(2)),
  rpId: "2512921.cn",
  userVerification: "required",
};
const credential = {
  id: helpers.encodeBase64url(bytes(3)),
  rawId: bytes(3),
  type: "public-key",
  response: {
    clientDataJSON: bytes(4),
    authenticatorData: bytes(5),
    signature: bytes(6),
    userHandle: null,
  },
};
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((n) => find(n, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...find(tree.props?.children, predicate),
  ];
}
function text(tree) {
  if (typeof tree === "string") return tree;
  if (Array.isArray(tree)) return tree.map(text).join("");
  return text(tree?.props?.children || "");
}
function harness({
  browserGet = async () => credential,
  browserCreate = async () => ({
    ...credential,
    response: { clientDataJSON: bytes(4), attestationObject: bytes(5) },
  }),
} = {}) {
  const slots = [],
    calls = [],
    logins = [],
    updates = [],
    csrf = [];
  let index = 0,
    props = {
      pending,
      onPending: (p) => updates.push(p),
      onSession: (s) => logins.push(s),
      onCancel: () => updates.push(null),
    };
  const exports = {};
  vm.runInNewContext(compile("../src/features/admin/MfaAuth.tsx"), {
    exports,
    AbortController,
    DOMException,
    Error,
    window: { PublicKeyCredential: class {} },
    navigator: { credentials: { get: browserGet, create: browserCreate } },
    require(name) {
      if (name === "react/jsx-runtime") return jsx;
      if (name === "react")
        return {
          useState(value) {
            const key = index++;
            if (!(key in slots)) slots[key] = value;
            return [
              slots[key],
              (next) => {
                slots[key] =
                  typeof next === "function" ? next(slots[key]) : next;
              },
            ];
          },
          useRef(value) {
            const key = index++;
            if (!(key in slots)) slots[key] = { current: value };
            return slots[key];
          },
          useEffect() {},
        };
      if (name === "./webauthn") return helpers;
      if (name === "./ui") return { ErrorBox: () => null };
      if (name === "./api")
        return {
          message: (e) => e.message,
          rememberCsrf: (v) => csrf.push(v),
          rememberSession: (s) => csrf.push(s?.csrf_token),
          async request(path, method, body, signal) {
            calls.push({ path, method, body, signal });
            if (path.endsWith("/options"))
              return {
                data: {
                  public_key: {
                    ...options,
                    rp: { id: "2512921.cn", name: "TwinNKU" },
                    user: {
                      id: helpers.encodeBase64url(bytes(1)),
                      name: "staff",
                      displayName: "成员",
                    },
                  },
                },
              };
            if (path === "/auth/mfa/authentication/verify")
              return { data: session };
            if (path === "/auth/mfa/registration/verify")
              return { data: pending };
            if (path === "/auth/mfa/recovery")
              return {
                data: {
                  ...pending,
                  status: "enrollment_required",
                  csrf_token: "recovery-csrf",
                },
              };
            throw new Error(path);
          },
        };
      throw new Error(name);
    },
  });
  return {
    calls,
    logins,
    updates,
    csrf,
    render(p) {
      if (p) props = { ...props, ...p };
      index = 0;
      return exports.PendingMfa(props);
    },
  };
}

test("WebAuthn binary conversion preserves UV and every descriptor ID", () => {
  const roundtrip = helpers.decodeBase64url(helpers.encodeBase64url(bytes(42)));
  assert.deepEqual(new Uint8Array(roundtrip), new Uint8Array(bytes(42)));
  const request = helpers.assertionOptions({
    ...options,
    allowCredentials: [{ type: "public-key", id: credential.id }],
  });
  assert.equal(request.userVerification, "required");
  assert.deepEqual(
    new Uint8Array(request.allowCredentials[0].id),
    new Uint8Array(credential.rawId),
  );
  const creation = helpers.creationOptions({
    ...options,
    user: { id: credential.id, name: "staff", displayName: "成员" },
    authenticatorSelection: { userVerification: "required" },
    excludeCredentials: [{ type: "public-key", id: credential.id }],
  });
  assert.equal(creation.authenticatorSelection.userVerification, "required");
  assert.deepEqual(
    new Uint8Array(creation.user.id),
    new Uint8Array(credential.rawId),
  );
});

test("proof serialization retains signatures and does not invent a user handle", () => {
  const proof = helpers.serializeCredential(credential);
  assert.equal(
    proof.response.signature,
    helpers.encodeBase64url(credential.response.signature),
  );
  assert.equal(proof.response.userHandle, null);
  assert.equal(proof.rawId, credential.id);
});

test("pending login obtains a real browser proof before the verified session callback", async () => {
  const h = harness();
  const tree = h.render();
  assert.equal(h.logins.length, 0);
  await find(
    tree,
    (n) => n.type === "button" && text(n).includes("验证通行密钥"),
  )[0].props.onClick();
  // React handler starts the promise without making it an implicit post retry.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    h.calls.map((c) => c.path),
    ["/auth/mfa/authentication/options", "/auth/mfa/authentication/verify"],
  );
  assert.equal(h.logins[0], session);
  assert.equal(h.csrf.at(-1), session.csrf_token);
  assert.ok(h.calls[1].body.credential.response.signature);
});

test("registration alone remains pending until a separate login assertion", async () => {
  const h = harness();
  const tree = h.render({
    pending: { ...pending, status: "enrollment_required" },
  });
  find(tree, (n) => n.type === "form")[0].props.onSubmit({
    preventDefault() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    h.calls.map((c) => c.path),
    ["/auth/mfa/registration/options", "/auth/mfa/registration/verify"],
  );
  assert.equal(h.logins.length, 0);
  assert.equal(h.updates[0].status, "mfa_required");
});

test("an existing factor verifies before a forced password change", () => {
  const h = harness();
  const tree = h.render({
    pending: { ...pending, must_change_password: true },
  });
  assert.equal(find(tree, (n) => n.type === "form").length, 0);
  assert.ok(
    find(tree, (n) => n.type === "button" && text(n).includes("验证通行密钥"))
      .length,
  );
  const enrollment = h.render({
    pending: {
      ...pending,
      status: "enrollment_required",
      must_change_password: true,
    },
  });
  assert.equal(find(enrollment, (n) => n.type === "form").length, 1);
  assert.equal(
    find(enrollment, (n) => n.type === "input" && n.props.type === "password")
      .length,
    2,
  );
});

test("cancelling the browser ceremony prevents any later verification request", async () => {
  let resolve;
  const h = harness({
    browserGet: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  let tree = h.render();
  find(
    tree,
    (n) => n.type === "button" && text(n).includes("验证通行密钥"),
  )[0].props.onClick();
  await new Promise((r) => setImmediate(r));
  tree = h.render();
  find(
    tree,
    (n) => n.type === "button" && text(n).includes("取消"),
  )[0].props.onClick();
  resolve(credential);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1);
  assert.equal(h.logins.length, 0);
});

test("a lost-factor recovery result only exposes enrollment and never a staff session", async () => {
  const h = harness();
  let tree = h.render({ pending: { ...pending, status: "recovery_required" } });
  find(
    tree,
    (n) => n.type === "button" && text(n).includes("恢复码"),
  )[0].props.onClick();
  tree = h.render();
  find(tree, (n) => n.type === "input")[0].props.onChange({
    target: { value: "an-offline-test-recovery-code" },
  });
  tree = h.render();
  find(tree, (n) => n.type === "form")[0].props.onSubmit({
    preventDefault() {},
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.logins.length, 0);
  assert.equal(h.updates[0].status, "enrollment_required");
  assert.equal(h.csrf.at(-1), "recovery-csrf");
});

test("MFA step-up rejection opens verification without replaying a write", async () => {
  const exports = {},
    events = [],
    calls = [];
  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  vm.runInNewContext(compile("../src/features/admin/api.ts"), {
    exports,
    Blob,
    DOMException,
    Event,
    window: { dispatchEvent: (e) => events.push(e.type) },
    fetch: async (path, args) => {
      calls.push({ path, args });
      return {
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: "MFA_STEP_UP_REQUIRED", message: "请再次验证" },
        }),
      };
    },
    require(name) {
      if (name.endsWith("api/client")) return { ApiError };
      if (name.endsWith("requestDeadline"))
        return { withRequestDeadline: (load) => load() };
      throw new Error(name);
    },
  });
  await assert.rejects(
    exports.request("/points/publish", "POST", { expected_revision: 2 }),
    (e) => e.status === 403,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(events, ["staff-mfa-required"]);
});
