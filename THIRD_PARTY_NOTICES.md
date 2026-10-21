# Third-party components and provenance

Apache-2.0 in the root `LICENSE` covers project-owned code and documentation. It does not replace upstream terms for dependencies, base images, toolchains, model code or weights. Retain license and notice files delivered with those components when redistributing them.

| Component | Source / dependency inventory | License and attribution reference |
| --- | --- | --- |
| Node.js and base Linux images | Storage, tooling and gateway Dockerfiles | [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE) and selected image's package notices |
| Caddy | Public HTTPS Compose overlay | [Caddy license](https://github.com/caddyserver/caddy/blob/master/LICENSE) |
| vLLM and vLLM-Omni | Pinned GPU image and Python packages | [vLLM](https://github.com/vllm-project/vllm/blob/main/LICENSE) and [vLLM-Omni](https://github.com/vllm-project/vllm-omni/blob/main/LICENSE) |
| VoxCPM implementation | Pinned `voxcpm` package | [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM) and installed license files |
| VoxCPM2 weights | Pinned revision downloaded on target host | [Model repository](https://huggingface.co/openbmb/VoxCPM2/tree/32279effe8c19989596f05d353d1447f51d9e915) |
| OpenZeppelin, ethers, Ganache and solc | `contracts/package-lock.json` | Installed package licenses and transitive notices |
| ethers | `services/package-lock.json` | Installed package licenses and notices |
| Synapse SDK/core and viem | `storage/package-lock.json` | Installed package licenses and notices |

The npm lockfiles retain dependency license declarations. Only this project's root package entries use the root Apache-2.0 declaration; nested package metadata continues to describe the original dependencies. Lockfiles are inventories, not substitutes for complete installed notices.

## Adapted configuration

`tts/voxcpm2.yaml` is based on the vLLM-Omni release configuration at commit `a8576ccb725c4e21cd13c3eb5f9a546b21149d2b`. ATS changes resource/concurrency configuration and disables remote model repository code. Attribution remains in the file and `tts/README.zh-Hant.md`. The startup helper applies deployment overrides to a private copy.

## Distribution boundary

Git and source archives exclude downloaded packages, model weights, built images, runtime databases and operator credentials. Built distributions introduce their own dependency sets; retain the notices present in those installed artifacts. The project does not claim ownership of upstream names or assets.
