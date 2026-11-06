# Third-party components and provenance

The root Apache-2.0 license applies to project-owned code and documentation. Dependencies, base images, toolchains, model code and weights retain their upstream terms. Preserve the notices and licenses supplied with each redistributed component.

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

Use the npm lockfiles to identify the resolved packages and the notices shipped with each installed package for its license terms. The project declares Apache-2.0 for its own package entries. Dependency entries retain the corresponding upstream declarations.

## Adapted configuration

`tts/voxcpm2.yaml` is based on the vLLM-Omni release configuration at commit `a8576ccb725c4e21cd13c3eb5f9a546b21149d2b`. ATS adjusts resource and concurrency settings and disables remote model repository code. The startup helper applies deployment overrides to a private copy of the YAML. The source file and speech guide record the attribution. [Speech guide](tts/README.md)

## Distribution boundary

Git and source archives contain source and configuration templates. Downloaded packages, model weights, built images, runtime databases and operator credentials are managed separately. When distributing a build, retain the notices for the specific components it includes.
