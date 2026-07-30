"""
Pulsely server SDK for Python — standard library only.

    from pulsely import Pulsely

    bp = Pulsely(
        app_id=os.environ["PULSELY_APP_ID"],
        app_key=os.environ["PULSELY_APP_KEY"],
        app_secret=os.environ["PULSELY_APP_SECRET"],
        base_url="https://pulsely.example.com",
    )

    bp.trigger("orders", "created", {"id": 42})

The app secret must never reach a browser.
"""

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request


class PulselyError(Exception):
    """Raised when a publish is rejected or the request cannot be made."""

    def __init__(self, message, status=0, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class Pulsely:
    def __init__(self, app_id, app_secret, app_key=None,
                 base_url="http://127.0.0.1:8085", timeout=10):
        if not app_id or not app_secret:
            raise PulselyError("Pulsely: app_id and app_secret are required.")
        self.app_id = app_id
        self.app_key = app_key
        self.app_secret = app_secret
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def trigger(self, channel, event, data=None):
        """Publish an event to a channel. Raises PulselyError on any non-2xx."""
        # Serialize once and send exactly these bytes. Re-serializing for the
        # request risks a different key order and a signature that no longer
        # matches the body — the most common cause of a puzzling 401.
        payload = json.dumps(
            {"channel": channel, "event": event, "data": data if data is not None else {}},
            separators=(",", ":"),
        ).encode("utf-8")

        path = f"/apps/{self.app_id}/events"
        timestamp = str(int(time.time()))  # epoch SECONDS, UTC

        request = urllib.request.Request(
            self.base_url + path,
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Pulsely-Timestamp": timestamp,
                "X-Pulsely-Signature": self._sign("POST", path, timestamp, payload),
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return self._parse(response.read())
        except urllib.error.HTTPError as err:
            body = self._parse(err.read())
            message = body.get("error", body) if isinstance(body, dict) else body
            raise PulselyError(
                f"Pulsely: publish rejected ({err.code}) — {message}", err.code, body
            ) from None
        except urllib.error.URLError as err:
            raise PulselyError(f"Pulsely: request failed — {err.reason}") from None

    def list_channels(self, filter_by_prefix=None, info=None):
        """
        Every currently occupied channel, as {"channel_name": {}} — or
        {"user_count": N} for a presence channel when info="user_count".

        Raises PulselyError on any non-2xx.
        """
        path = f"/apps/{self.app_id}/channels"
        query = {}
        if filter_by_prefix:
            query["filter_by_prefix"] = filter_by_prefix
        if info:
            query["info"] = info
        return self._get(path, query).get("channels", {})

    def get_channel(self, channel_name):
        """
        Detail for one channel: {occupied, subscription_count, user_count?}.
        Returns rather than raising for an unoccupied channel — "not
        occupied" is a normal state, not a missing resource.

        Raises PulselyError on any non-2xx (e.g. an invalid channel name).
        """
        path = f"/apps/{self.app_id}/channels/{channel_name}"
        return self._get(path, {})

    def _get(self, path, query):
        """
        Signed GET request against the given (unsigned, no query string)
        path. Query params are appended after signing — they are never part
        of the signing string.
        """
        timestamp = str(int(time.time()))
        signature = self._sign("GET", path, timestamp, b"")
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)

        request = urllib.request.Request(
            url,
            method="GET",
            headers={
                "X-Pulsely-Timestamp": timestamp,
                "X-Pulsely-Signature": signature,
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return self._parse(response.read())
        except urllib.error.HTTPError as err:
            body = self._parse(err.read())
            message = body.get("error", body) if isinstance(body, dict) else body
            raise PulselyError(
                f"Pulsely: request rejected ({err.code}) — {message}", err.code, body
            ) from None
        except urllib.error.URLError as err:
            raise PulselyError(f"Pulsely: request failed — {err.reason}") from None

    def auth_token(self, user_id, ttl_seconds=3600):
        """
        Mint a short-lived connection token for a browser.

        The browser presents it as the STOMP passcode; it establishes the identity
        your auth endpoint later sees as `user_token`. Public channels need none.
        """
        if not self.app_key:
            raise PulselyError("Pulsely: app_key is required to mint connection tokens.")

        expires = int(time.time()) + ttl_seconds
        signature = hmac.new(
            self.app_secret.encode("utf-8"),
            f"{self.app_key}:{expires}:{user_id}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        return f"{expires}.{user_id}.{signature}"

    def authorize_channel(self, authorized=True, user_id="", user_info=None):
        """
        Build the response your auth endpoint returns when Pulsely asks whether
        a subscriber may join a private or presence channel.

        Presence channels need user_id; user_info is echoed to every other member.
        """
        return {
            "authorized": bool(authorized),
            "user_id": str(user_id),
            "user_info": user_info if user_info is not None else {},
        }

    def verify_webhook(self, raw_body, headers=None, tolerance_seconds=300):
        """
        Verify an inbound event webhook really came from Pulsely.

        Pass the RAW request body bytes, not a re-serialized object.
        """
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        timestamp = headers.get("x-pulsely-timestamp")
        signature = headers.get("x-pulsely-signature")
        if not timestamp or not signature:
            return False

        try:
            if abs(int(time.time()) - int(timestamp)) > tolerance_seconds:
                return False
        except ValueError:
            return False

        if isinstance(raw_body, str):
            raw_body = raw_body.encode("utf-8")

        expected = self._sign("POST", "/webhook", str(timestamp), raw_body)
        return hmac.compare_digest(expected, str(signature))

    def _sign(self, method, path, timestamp, payload):
        body_hash = hashlib.sha256(payload).hexdigest()
        # Joined by real newlines, not the two characters backslash-n.
        signing_string = f"{method.upper()}\n{path}\n{timestamp}\n{body_hash}"
        return hmac.new(
            self.app_secret.encode("utf-8"), signing_string.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    @staticmethod
    def _parse(raw):
        text = raw.decode("utf-8", "replace")
        try:
            return json.loads(text)
        except ValueError:
            return text
