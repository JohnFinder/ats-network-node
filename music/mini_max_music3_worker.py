"""Authenticated loopback MM3 adapter. No weights, downloads, or GPU process lifecycle.

The operator owns an on-demand SGLang-Omni service on loopback. This adapter
forwards one generation at a time, never retries, and returns its WAV unchanged.
Uses only the Python standard library (Python 3.12+ recommended for WAV extensible).
"""
import hmac
import http.client
import io
import json
import math
import os
import re
import secrets
import socket
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MODEL_ID = "MiniMaxAI/MiniMax-Music3"
MAX_AUDIO_BYTES = 50_000_000
LOCK = threading.Lock()
TAG = re.compile(r"\[(?:Verse(?:\s+\d+)?|Chorus(?:\s+\d+)?|Intro|Bridge|Outro|Pre-Chorus|Post-Chorus|Instrumental|Solo)\]", re.I)


class RequestError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(code)


def positive_integer(name, fallback, maximum):
    value = int(os.environ.get(name, str(fallback)))
    if not 0 < value <= maximum:
        raise ValueError(f"Invalid {name}")
    return value


class Config:
    def __init__(self):
        self.secret = os.environ.get("NODE_MUSIC_WORKER_API_KEY_MINIMAX_MUSIC3", os.environ.get("NODE_MUSIC_WORKER_API_KEY", ""))
        if not 24 <= len(self.secret) <= 4096 or re.search(r"\s", self.secret):
            raise ValueError("Set a separate NODE_MUSIC_WORKER_API_KEY_MINIMAX_MUSIC3 (or NODE_MUSIC_WORKER_API_KEY)")
        if self.secret in os.environ.get("NODE_MUSIC_API_KEYS", "").split(","):
            raise ValueError("Worker credentials must differ from client credentials")
        self.max_seconds = positive_integer("NODE_MUSIC_MAX_SECONDS_MINIMAX_MUSIC3", 360, 360)
        if self.max_seconds < 3:
            raise ValueError("MM3 duration limit must be at least 3 seconds")
        self.timeout = positive_integer("NODE_MUSIC_MM3_UPSTREAM_TIMEOUT_SECONDS", self.max_seconds * 2, 86400)
        self.port = positive_integer("NODE_MUSIC_MM3_WORKER_PORT", 8793, 65535)
        self.url = urlsplit(os.environ.get("NODE_MUSIC_MM3_UPSTREAM_URL", "http://127.0.0.1:8002/v1/audio/speech"))
        if (self.url.scheme not in ("http", "https") or self.url.hostname not in ("127.0.0.1", "localhost", "::1")
                or self.url.username or self.url.password or self.url.query or self.url.fragment
                or self.url.path != "/v1/audio/speech"):
            raise ValueError("MM3 upstream must be a loopback /v1/audio/speech URL without credentials, query or fragment")
        # A localhost hosts-file override must not redirect lyrics off-machine.
        self.host = "127.0.0.1" if self.url.hostname == "localhost" else self.url.hostname
        self.upstream_port = self.url.port
        self.upstream_model = os.environ.get("NODE_MUSIC_MM3_UPSTREAM_MODEL", MODEL_ID)
        if not self.upstream_model or len(self.upstream_model) > 512:
            raise ValueError("Invalid NODE_MUSIC_MM3_UPSTREAM_MODEL")
        self.lyrics_field = os.environ.get("NODE_MUSIC_MM3_LYRICS_FIELD", "input")
        if self.lyrics_field not in ("input", "lyrics"):
            raise ValueError("NODE_MUSIC_MM3_LYRICS_FIELD must be input or lyrics")
        self.default_instructions = os.environ.get("NODE_MUSIC_MM3_DEFAULT_INSTRUCTIONS", "A coherent song matching the supplied lyrics.")
        if not self.default_instructions.strip() or len(self.default_instructions.encode()) > 8192:
            raise ValueError("Invalid NODE_MUSIC_MM3_DEFAULT_INSTRUCTIONS")


def estimated_tokens(text):
    return sum(math.ceil(len(part) / 3) if re.match(r"[A-Za-z0-9]", part)
               else math.ceil(len(part) / 4) if part.isspace()
               else 4 if ord(part) > 0xFFFF else 1
               for part in re.findall(r"[A-Za-z0-9]+|\s+|[^\s]", text))


def generation_request(payload, config):
    def reject(code):
        raise RequestError(400, code)
    if not isinstance(payload, dict) or payload.get("model") != MODEL_ID:
        reject("invalid_generation_request")
    allowed = {"model", "prompt", "duration_seconds", "instrumental", "seed", "instructions", "caption"}
    if set(payload) - allowed:
        reject("generative_only" if any("ref" in key.lower() or key.lower() in ("voice", "melody") for key in set(payload) - allowed) else "unsupported_parameter")
    if payload.get("instrumental") is True:
        reject("instrumental_not_supported")
    if "instrumental" in payload and payload["instrumental"] is not False:
        reject("invalid_instrumental")
    seconds = payload.get("duration_seconds")
    if type(seconds) is not int or not 3 <= seconds <= config.max_seconds:
        reject("duration_out_of_range")
    lyrics = payload.get("prompt")
    if not isinstance(lyrics, str) or not lyrics.strip():
        reject("invalid_lyrics")
    if len(lyrics.encode()) > 16384 or estimated_tokens(lyrics) > 5000:
        reject("lyrics_too_long")
    for line in lyrics.splitlines():
        tags = TAG.findall(line)
        if tags and (len(tags) != 1 or line.strip() != tags[0]):
            reject("lyrics_structure_tag_must_be_on_own_line")
    for key in ("instructions", "caption"):
        if key in payload and not isinstance(payload[key], str):
            reject("invalid_instructions")
    if "instructions" in payload and "caption" in payload and payload["instructions"] != payload["caption"]:
        reject("caption_conflict")
    instructions = payload.get("instructions", payload.get("caption", ""))
    if len(instructions.encode()) > 8192:
        reject("invalid_instructions")
    if not instructions.strip():
        instructions = config.default_instructions
    if estimated_tokens(lyrics) + estimated_tokens(instructions) > 5000:
        reject("lyrics_too_long")
    seed = payload["seed"] if "seed" in payload else secrets.randbelow(2**31)
    if type(seed) is not int or not 0 <= seed <= 2**53 - 1:
        reject("invalid_seed")
    return {"model": config.upstream_model, config.lyrics_field: lyrics, "instructions": instructions,
            "seed": seed, "max_new_tokens": seconds * 25, "response_format": "wav", "stream": False}


def validate_wav(content, seconds):
    try:
        if len(content) < 44 or content[:4] != b"RIFF" or content[8:12] != b"WAVE" or int.from_bytes(content[4:8], "little") + 8 != len(content):
            raise ValueError()
        with wave.open(io.BytesIO(content), "rb") as audio:
            frames = audio.getnframes()
            if (audio.getnchannels() != 2 or audio.getframerate() != 32000 or audio.getsampwidth() != 2
                    or audio.getcomptype() != "NONE" or frames <= 0 or frames / 32000 > seconds + .1
                    or len(audio.readframes(frames)) != frames * 4):
                raise ValueError()
    except (ValueError, EOFError, wave.Error):
        raise RequestError(502, "invalid_upstream_wav") from None


def generate(request, config):
    """A total wall-clock deadline, including headers and a slowly dripping body.

    HTTPConnection has no redirect/proxy handling. A watchdog shuts down the
    connected loopback socket, rather than resetting a per-read timeout forever.
    """
    started = time.monotonic()
    connection_type = http.client.HTTPSConnection if config.url.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(config.host, config.upstream_port, timeout=config.timeout)
    timer, response = None, None
    timed_out = threading.Event()
    try:
        connection.connect()
        connected_socket = connection.sock
        def expire():
            timed_out.set()
            try:
                connected_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connected_socket.close()
        timer = threading.Timer(max(0, config.timeout - (time.monotonic() - started)), expire)
        timer.daemon = True
        timer.start()
        connection.request("POST", config.url.path, body=json.dumps(request).encode(),
                           headers={"Content-Type": "application/json", "Accept": "audio/wav"})
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise RequestError(502, "upstream_redirect_rejected")
        if 400 <= response.status < 500:
            detail = response.read(8192).decode("utf-8", "replace").lower()
            if any(word in detail for word in ("token", "5000", "5,000", "too long", "context length")):
                raise RequestError(400, "lyrics_too_long")
            raise RequestError(400, "upstream_request_rejected")
        if not 200 <= response.status < 300:
            raise RequestError(503, "upstream_unavailable")
        declared = response.getheader("Content-Length")
        if declared is not None and (not declared.isascii() or not declared.isdigit() or int(declared) > MAX_AUDIO_BYTES):
            raise RequestError(502, "invalid_upstream_wav")
        chunks, size = [], 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_AUDIO_BYTES:
                raise RequestError(502, "invalid_upstream_wav")
            chunks.append(chunk)
        if timed_out.is_set() or time.monotonic() - started >= config.timeout:
            raise RequestError(504, "upstream_timeout")
        if declared is not None and size != int(declared):
            raise RequestError(502, "invalid_upstream_wav")
        content = b"".join(chunks)
        validate_wav(content, request["max_new_tokens"] / 25)
        if timed_out.is_set() or time.monotonic() - started >= config.timeout:
            raise RequestError(504, "upstream_timeout")
        return content
    except RequestError:
        if timed_out.is_set() or time.monotonic() - started >= config.timeout:
            raise RequestError(504, "upstream_timeout") from None
        raise
    except (TimeoutError, socket.timeout):
        raise RequestError(504, "upstream_timeout") from None
    except (OSError, http.client.HTTPException):
        raise RequestError(504 if timed_out.is_set() else 503, "upstream_timeout" if timed_out.is_set() else "upstream_unavailable") from None
    finally:
        if timer:
            timer.cancel()
        if response:
            response.close()
        connection.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # Never log keys, lyrics, captions, or generated content.

    def send_json(self, status, code):
        content = json.dumps({"error": code}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(content)

    def do_POST(self):
        config = self.server.config
        self.connection.settimeout(30)
        try:
            if self.path != "/generate":
                raise RequestError(404, "not_found")
            auth = self.headers.get_all("Authorization", [])
            if len(auth) != 1 or not hmac.compare_digest(auth[0].encode(), ("Bearer " + config.secret).encode()):
                raise RequestError(401, "authentication_required")
            if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
                raise RequestError(400, "invalid_generation_request")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise RequestError(413, "invalid_body_size") from None
            if not 0 < length <= 32768:
                raise RequestError(413, "invalid_body_size")
            try:
                payload = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                raise RequestError(400, "invalid_generation_request") from None
            request = generation_request(payload, config)
            if not LOCK.acquire(blocking=False):
                raise RequestError(429, "worker_busy")
            try:
                content = generate(request, config)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(content)
            finally:
                LOCK.release()
        except RequestError as failure:
            self.send_json(failure.status, failure.code)
        except UnicodeError:
            self.send_json(400, "invalid_generation_request")
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.send_json(500, "generation_failed")


if __name__ == "__main__":
    configuration = Config()
    server = ThreadingHTTPServer(("127.0.0.1", configuration.port), Handler)
    server.config = configuration
    server.daemon_threads = True
    server.serve_forever()
