"""Loopback Stable Audio Open worker; only loads weights after the operator starts it.

Model API follows https://huggingface.co/stabilityai/stable-audio-open-1.0 .
Install dependencies and accept the model's access/license terms before starting.
"""
import hmac
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
import torch
from diffusers import StableAudioPipeline

MODEL_ID = os.environ.get("NODE_MUSIC_MODEL", "stabilityai/stable-audio-open-1.0")
if MODEL_ID != "stabilityai/stable-audio-open-1.0":
    raise ValueError("This worker only implements the Stable Audio Open 1.0 contract")
DEVICE = os.environ.get("NODE_MUSIC_DEVICE", "cuda")
if DEVICE != "cuda" or not torch.cuda.is_available():
    raise RuntimeError("This worker requires a CUDA GPU; no silent CPU fallback")
SECRET = os.environ.get("NODE_MUSIC_WORKER_API_KEY", "")
if len(SECRET) < 24:
    raise ValueError("Set a separate NODE_MUSIC_WORKER_API_KEY of at least 24 characters")
PIPE = StableAudioPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.float16).to(DEVICE)
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        # Do not log credentials, scene descriptions, or generated content.
        pass

    def send_json(self, code, value):
        content = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(content)
        self.close_connection = True

    def do_POST(self):
        if self.path != "/generate":
            return self.send_json(404, {"error": "not_found"})
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode(), ("Bearer " + SECRET).encode()):
            return self.send_json(401, {"error": "authentication_required"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 20000:
                return self.send_json(413, {"error": "invalid_body_size"})
            payload = json.loads(self.rfile.read(length))
            prompt = payload["prompt"]
            seconds = payload["duration_seconds"]
            if payload.get("model") != MODEL_ID or not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 16384 or type(seconds) is not int or not 3 <= seconds <= 47 or payload.get("instrumental") is not True:
                return self.send_json(400, {"error": "invalid_generation_request"})
        except (KeyError, ValueError, TypeError):
            return self.send_json(400, {"error": "invalid_generation_request"})
        if not LOCK.acquire(blocking=False):
            return self.send_json(429, {"error": "worker_busy"})
        try:
            with torch.inference_mode():
                result = PIPE(prompt, negative_prompt="Vocals, speech, singing, distorted low quality audio", num_inference_steps=200,
                              audio_end_in_s=float(seconds), num_waveforms_per_prompt=1).audios
            audio = result[0].T.float().cpu().numpy()
            buffer = io.BytesIO()
            sf.write(buffer, audio, PIPE.vae.sampling_rate, format="WAV", subtype="PCM_16")
            content = buffer.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.send_json(500, {"error": "generation_failed"})
        finally:
            LOCK.release()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("NODE_MUSIC_WORKER_PORT", "8792"))), Handler)
    server.daemon_threads = True
    server.serve_forever()
