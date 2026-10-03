"""Offline, integrity-checked rejection of common and compromised passwords.

The bundled SHA-256 corpus is a blocklist, never a password-storage algorithm.
Accepted credentials still use Argon2id. No submitted password or hash leaves
the application, and old logins do not invoke this new-password policy.
"""

import hashlib
import unicodedata
from functools import lru_cache
from pathlib import Path

from app.core.errors import DomainError

BLOCKLIST = Path(__file__).with_name("data") / "password_blocklist.sha256"
ARTIFACT_SHA256 = "178b1a20e26827b3a733342740e99b81d2804a9d314f2996bee8d2e0bfd784e1"
ARTIFACT_COUNT = 13267
CONTEXT_WORDS = (
    "nankai",
    "nankaiuniversity",
    "twinnku",
    "nkgenios",
    "xiaokai",
    "南开",
    "南开大学",
    "小开",
    "津南",
    "八里台",
    "2512921",
    "2512921.cn",
    "admin",
    "administrator",
    "editor",
    "reviewer",
    "viewer",
)
COMMON_WEAK_BASES = ("password", "qwerty", "letmein", "welcome", "changeme", "iloveyou")


@lru_cache(maxsize=1)
def blocked_hashes():
    try:
        if BLOCKLIST.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("oversized policy")
        raw = BLOCKLIST.read_bytes()
        if hashlib.sha256(raw).hexdigest() != ARTIFACT_SHA256:
            raise ValueError("policy integrity mismatch")
        values = frozenset(raw.decode("ascii").splitlines())
        if len(values) != ARTIFACT_COUNT:
            raise ValueError("policy coverage mismatch")
        return values
    except (OSError, UnicodeError, ValueError):
        raise DomainError(
            "PASSWORD_POLICY_UNAVAILABLE", "密码保护资料暂不可用，请联系管理员", 503
        ) from None


def contextual_password(password):
    # Normalize only for the rejection comparison. Hash/verify the credential
    # exactly as received; do not alter case, Unicode, whitespace or length.
    candidate = unicodedata.normalize("NFKC", password).casefold()
    for word in CONTEXT_WORDS + COMMON_WEAK_BASES:
        before, found, after = candidate.partition(word)
        if found and all(not character.isalpha() for character in before + after):
            return True
    return False


def validate_password(password):
    if not 12 <= len(password) <= 128 or not password.strip():
        raise DomainError("PASSWORD_POLICY", "密码长度须为12至128个字符", 422)
    hashes = blocked_hashes()
    if contextual_password(password) or any(
        hashlib.sha256(value.encode("utf-8")).hexdigest() in hashes
        for value in {password, password.casefold()}
    ):
        raise DomainError("PASSWORD_TOO_COMMON", "此密码过于常见或与本站相关，请选择其他密码", 422)
