// Only browser WebAuthn produces proofs; no passwordless or TOTP downgrade path.
export function decodeBase64url(value: string): ArrayBuffer {
  const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  return bytes.buffer;
}
export function encodeBase64url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
type RawOptions = Record<string, unknown>;
type RawDescriptor = {
  id: string;
  type: "public-key";
  transports?: AuthenticatorTransport[];
};
export function assertionOptions(
  raw: RawOptions,
): PublicKeyCredentialRequestOptions {
  return {
    ...raw,
    challenge: decodeBase64url(raw.challenge as string),
    allowCredentials: (
      raw.allowCredentials as RawDescriptor[] | undefined
    )?.map((c) => ({
      ...c,
      id: decodeBase64url(c.id),
    })),
  } as PublicKeyCredentialRequestOptions;
}
export function creationOptions(
  raw: RawOptions,
): PublicKeyCredentialCreationOptions {
  const user = raw.user as { id: string; name: string; displayName: string };
  return {
    ...raw,
    user: { ...user, id: decodeBase64url(user.id) },
    challenge: decodeBase64url(raw.challenge as string),
    excludeCredentials: (
      raw.excludeCredentials as RawDescriptor[] | undefined
    )?.map((c) => ({
      ...c,
      id: decodeBase64url(c.id),
    })),
  } as PublicKeyCredentialCreationOptions;
}
export function serializeCredential(credential: PublicKeyCredential) {
  const response = credential.response;
  const common = {
    id: credential.id,
    rawId: encodeBase64url(credential.rawId),
    type: credential.type,
  };
  if ("attestationObject" in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    return {
      ...common,
      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
        attestationObject: encodeBase64url(attestation.attestationObject),
      },
    };
  }
  const assertion = response as AuthenticatorAssertionResponse;
  return {
    ...common,
    response: {
      clientDataJSON: encodeBase64url(response.clientDataJSON),
      authenticatorData: encodeBase64url(assertion.authenticatorData),
      signature: encodeBase64url(assertion.signature),
      userHandle: assertion.userHandle
        ? encodeBase64url(assertion.userHandle)
        : null,
    },
  };
}
export function webauthnMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError")
      return "验证已取消或等待超时，请重新尝试。";
    if (error.name === "NotSupportedError")
      return "当前认证器不支持用户验证，请使用支持 PIN、指纹或面容验证的认证器。";
    if (error.name === "InvalidStateError")
      return "此认证器已经登记，请改用备用认证器。";
    if (error.name === "SecurityError")
      return "请从 https://2512921.cn/admin 使用安全连接进行验证。";
  }
  return error instanceof Error ? error.message : "验证未完成，请重试。";
}
