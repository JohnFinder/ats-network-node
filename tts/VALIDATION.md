# GPU deployment validation record

## October 21, 2026 — Gateway delivery

The Node.js 24 gateway image built successfully. The combined GPU and public HTTPS Compose configuration validated with an example domain. This check covered configuration parsing. Live DNS, TLS issuance and public routing still needed verification.

The gateway passed 18 checks in an isolated Docker network with a simulated engine. The checks covered API keys, model readiness, WAV forwarding, the language field, URL and file reference rejection, model and request size limits, admission limits, and slot release after cancellation or timeout.

The run used synthetic data and temporary credentials. The containers and isolated network were removed afterward. The Mac used for these checks had no NVIDIA GPU. Linux engine startup, audio quality, VRAM use, real-time factor and throughput require measurement on the target NVIDIA host.

## October 22, 2026 — Configurable concurrency

The update made gateway admission, engine sequence capacity and decode graph batch capacity configurable from 1 to 128. The default remained 8. The engine also continued to accept YAML configuration.

Static checks covered JavaScript syntax for the gateway and benchmark, Python syntax for the engine launcher, Compose and engine YAML, the Git diff and the existing localization catalogs. The update involved static checks only. The October 21 runtime checks apply to the earlier gateway revision.

The fixed 6 GiB KV cache does not grow with the sequence limit. Before public operation, validate engine startup and audio quality and record the GPU and driver versions. Measure concurrency at 1, 4 and 8, then increase the load while checking peak VRAM, throughput and p95 latency. The record has no 128-request hardware measurements. [Benchmark procedure](README.md#benchmark-the-target-gpu)
