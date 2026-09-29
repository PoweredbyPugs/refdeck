"""Optional single-user login, for instances that leave the LAN.

Off unless REFDECK_AUTH_USER and REFDECK_AUTH_HASH are both set. Make a hash
with `python -m app.auth` (prompts for the password). The hash uses ':' as its
separator, never '$', so it survives docker compose's .env interpolation.
"""
from __future__ import annotations

import getpass
import hashlib
import hmac
import os
import secrets
import threading
import time

COOKIE = "refdeck_session"
SESSION_TTL = 30 * 24 * 3600  # "remember me" is the only mode: 30 days
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1, "dklen": 32}
FREE_FAILURES = 5          # wrong passwords allowed before the backoff starts
MAX_LOCKOUT = 300          # seconds — caps how long a flood can lock out the real user


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **SCRYPT)
    return f"scrypt:{salt.hex()}:{digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split(":")
        salt = bytes.fromhex(salt_hex)
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    digest = hashlib.scrypt(password.encode(), salt=salt, **SCRYPT)
    return hmac.compare_digest(digest.hex(), digest_hex)


class Auth:
    def __init__(self, user: str, password_hash: str, secret: str = "",
                 secure_cookie: bool = True, clock=time.time):
        self.user = user
        self.password_hash = password_hash
        # no secret configured: sessions just don't survive a restart
        secret = secret or secrets.token_hex(32)
        # keyed on the hash too, so changing the password logs everyone out
        self.key = hashlib.sha256(f"{secret}:{password_hash}".encode()).digest()
        self.secure_cookie = secure_cookie
        self.clock = clock
        self.failures: dict[str, tuple[int, float]] = {}
        self.lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "Auth | None":
        user = os.environ.get("REFDECK_AUTH_USER", "").strip()
        password_hash = os.environ.get("REFDECK_AUTH_HASH", "").strip()
        if not (user and password_hash):
            return None
        return cls(user, password_hash, os.environ.get("REFDECK_SECRET", ""),
                   secure_cookie=os.environ.get("REFDECK_COOKIE_SECURE", "1") != "0")

    def _sign(self, expires: int) -> str:
        return hmac.new(self.key, f"{self.user}:{expires}".encode(), hashlib.sha256).hexdigest()

    def issue(self) -> str:
        expires = int(self.clock()) + SESSION_TTL
        return f"{expires}.{self._sign(expires)}"

    def valid(self, token: str | None) -> bool:
        if not token:
            return False
        expires_raw, _, sig = token.partition(".")
        try:
            expires = int(expires_raw)
        except ValueError:
            return False
        return expires > self.clock() and hmac.compare_digest(sig, self._sign(expires))

    def retry_after(self, client: str) -> int:
        """Seconds this client must wait before another attempt (0 = go ahead)."""
        with self.lock:
            count, last = self.failures.get(client, (0, 0.0))
        if count < FREE_FAILURES:
            return 0
        wait = min(2 ** (count - FREE_FAILURES + 1), MAX_LOCKOUT)
        return max(0, int(last + wait - self.clock() + 0.999))

    def attempt(self, client: str, username: str, password: str) -> bool:
        # always run scrypt, even for a wrong username — no timing tell
        ok = verify_password(password, self.password_hash)
        ok = hmac.compare_digest(username.strip().lower(), self.user.lower()) and ok
        with self.lock:
            if ok:
                self.failures.pop(client, None)
            else:
                count, _ = self.failures.get(client, (0, 0.0))
                self.failures[client] = (count + 1, self.clock())
        return ok


if __name__ == "__main__":
    first = getpass.getpass("Password: ")
    if first != getpass.getpass("Again: "):
        raise SystemExit("passwords differ")
    print(hash_password(first))
