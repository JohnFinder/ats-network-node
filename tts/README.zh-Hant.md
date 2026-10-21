# VoxCPM2 GPU 節點

GPU 節點同時提供文檔儲存、公開檢索和 VoxCPM2 語音合成。App 透過同一套本地語音流程使用這個端點；文件內容和參考聲音會傳送到使用者選擇的節點。節點不記錄文字、音訊或 API key，不保存合成結果。語音服務目前由營運者發放 API key，沒有自動收費、代幣支付或推理獎勵；原有儲存／鏈上結算規則維持原狀。

## 部署

使用 Linux x86_64、支援 BF16 的 NVIDIA GPU、Docker Compose V2 與 NVIDIA Container Toolkit。初版建議獨占一張 24 GB 或以上顯存的 GPU，例如 RTX 4090、L4、A10、A100 或 H100，32 GB 以上系統記憶體，並預留至少 30 GB 快取空間。固定版本使用 CUDA 13.0 映像，NVIDIA 驅動須支援該 runtime；一般 Linux 主機使用 R580 或更新的相容驅動，資料中心相容模式以 NVIDIA 官方相容性表為準。請先用相應 CUDA 容器確認 GPU 可見。

```sh
cp .env.example .env
sh scripts/start-gpu-node.sh
```

啟動工具只需要主機安裝 Docker。它會顯示 GPU 型號／顯存／驅動，使用密碼學亂數建立 `secrets/tts_api_key`，保留既有 key，自動處理非 root gateway 的讀取群組，再建立三個服務。Key 不會印到終端、不放進 `.env` 或 Git。檔案是擁有者可寫、群組可讀的 `0640`；其父目錄是 `0700`。只有授權用戶需要透過營運者自己的安全渠道取得 key。

首次啟動需下載模型並編譯 CUDA 核心，通常比之後啟動久；模型與編譯快取放在 `tts-model-cache` volume。健康檢查最多給予 15 分鐘啟動期。不要刪除 volume 來處理一般重啟問題。對外服務前，在目標機器完成下述實際合成與效能驗證。

預設只綁定主機 loopback：儲存服務 `8787`、語音 gateway `8791`；推理引擎沒有公開 port。公開 HTTPS 部署先設定 `.env` 的 `NODE_DOMAIN`，並使 DNS 指向主機，再執行：

```sh
sh scripts/start-gpu-node.sh --public
```

此命令會額外套用 Caddy 自動 TLS 和 GPU 路由。App 填入 `https://你的網域` 與 API key 即可。`GET /v1/node` 宣告 TTS 位址與認證方式，實際可用狀態以帶 key 的 `GET /v1/models` 為準。CPU 儲存節點仍可使用原本 `docker compose up -d`。

API key 更換：先停止 `tts` gateway，把舊 key 移到安全備份位置，再執行啟動工具產生新 key，重新建立 gateway 並將新 key 分發給授權用戶。既有連線在 gateway 停止時取消。初版每節點只有一個 key；如需按用戶撤銷、配額或計費，需另行加入憑證管理層。

## 固定推理環境與速度

採用官方 **vLLM-Omni v0.30.0**，與 vLLM 0.30.0 配套，官方映像以 SHA256 digest 固定；VoxCPM 依賴固定為 2.0.3，模型權重固定為 `32279effe8c19989596f05d353d1447f51d9e915`。`voxcpm2.yaml` 以上游 release 為基礎，固定 KV cache 預算並提供可調整的並發容量；`trust_remote_code` 關閉，避免下載執行模型倉庫程式。

該設定使用長駐引擎、連續批次、批次 CFM 與 AudioVAE、融合 QKV／MLP、零時間步快取及模型內部 unified decode CUDA graph。預設 KV cache 固定 6 GiB、最多八個序列，保留 CFM/VAE 額外顯存。保留 `enforce_eager: true` 是上游的模型相容性要求；模型內部 CUDA graph 仍會工作。不要為了「開啟 CUDA graph」直接反轉此選項。

這是官方支援且具批次最佳化的 NVIDIA 服務方案。沒有跨所有 GPU、句長、語言和併發量都最快的固定組態；初版沿用上游品質設定，沒有藉減少擴散步數或降低取樣率換取速度。部署容量範圍為 **1–128**，預設仍為 8；超出 Gateway 接納數時立即回傳 `429`／`Retry-After: 2`，不建立無限等待佇列。請在目標 GPU 預熱後從 1、4、8 逐步提高並發數，以吞吐量、p95 延遲及峰值顯存決定實際配置。

## 部署並發參數

建議在 倉庫根目錄的 `.env` 設定共用值，例如以下配置會讓 Gateway 最多接納 128 個未完成的合成請求，並將引擎序列上限及 unified decode graph 批次上限都設為 128：

```dotenv
TTS_MAX_CONCURRENT=128
```

| 參數 | 預設／範圍 | 作用 |
| --- | --- | --- |
| `TTS_MAX_CONCURRENT` | 8／1–128 | Compose 同時傳入 Gateway 與引擎；引擎啟動時覆蓋 YAML 的 `max_num_seqs` 和 `unified_decode_graph_max_batch_size` |
| `TTS_CUDA_GRAPH_MAX_BATCH_SIZE` | 空／1–引擎序列上限 | 可單獨降低 graph 批次容量；有共用並發值時，空值跟隨該值，否則保留 YAML graph 設定 |
| `TTS_GATEWAY_MEMORY_LIMIT` | `1g` | Gateway 容器系統記憶體上限；大量同時上傳參考 WAV 時需按實際用量提高 |
| `TTS_GATEWAY_CPUS` | `2` | Gateway 容器 CPU 額度，可按 JSON／WAV 處理需求調整 |

引擎啟動工具會先檢查整數範圍和 graph 批次容量不得大於序列上限，再將有效設定寫入容器內私有臨時 YAML，最後啟動 `vllm serve`。掛載的原始 YAML 不會被改寫；啟動日誌會顯示有效的兩個批次上限。`0`、超過 `128`、小數或格式錯誤會拒絕啟動。

也可以直接透過 YAML 配置：Gateway 在 Compose 的 `tts.environment.TTS_MAX_CONCURRENT` 設定接納數；引擎的 `voxcpm2.environment.TTS_MAX_CONCURRENT` 設為空字串，便會使用掛載的 `tts/voxcpm2.yaml`。例如在最後套用的 Compose override 中寫入：

```yaml
services:
  tts:
    environment:
      TTS_MAX_CONCURRENT: "128"
  voxcpm2:
    environment:
      TTS_MAX_CONCURRENT: ""
      TTS_CUDA_GRAPH_MAX_BATCH_SIZE: ""
```

此時將 `tts/voxcpm2.yaml` 的 `stages[0].max_num_seqs` 及 `stages[0].engine_extras.hf_overrides.voxcpm2_runtime_config.unified_decode_graph_max_batch_size` 設為所需值（1–128）。Gateway 接納數應小於或等於引擎序列上限。若直接啟動引擎容器，未提供或留空的環境變量亦使用 YAML；非空的環境變量優先。獨立 Gateway 未提供環境變量時仍預設 8。

修改後需重新建立 Gateway 和引擎容器。使用上述 `.env` 方式的節點，重新執行原本的 `scripts/start-gpu-node.sh`（公開節點保留 `--public`）；首次套用本次程式更新需要重建映像。自行使用 Compose override 時，重新部署時需保留同一組 override 檔案。

**128 是可配置的接納／排程上限，尚未在目標 GPU 驗證 128 路效能。** `kv_cache_memory_bytes` 仍明確固定為 6 GiB，增加序列數不會自動擴大 KV cache，也不代表每個請求都同時佔用完整 `max_model_len`。如需調整容量，請另外修改 YAML 的 KV 預算、`max_model_len` 和 `max_num_batched_tokens`，並為 CFM、AudioVAE、CUDA graph 批次池及其他 GPU 服務預留顯存。graph 批次上限可較小，但不會限制其他模型支路的批次分配；它不是總顯存上限。長句及大量參考音訊也可能需要提高 Gateway 記憶體與 `TTS_TIMEOUT_SECONDS`（5–600 秒）；公開節點若提高逾時，亦需調整 `Caddyfile.gpu` 的 `response_header_timeout`，其預設為 190 秒。

## App 介面契約

所有模型資訊和合成請求都要求 `Authorization: Bearer <API key>`。不需要另一套語音供應商協定。

```http
GET /v1/models
Authorization: Bearer <API key>
```

引擎就緒後回傳 OpenAI 格式模型列表，ID 為 `openbmb/VoxCPM2`，音訊為 48 kHz。尚未就緒回傳 `503`。

```json
{
  "model": "openbmb/VoxCPM2",
  "input": "要合成的完整句子。",
  "voice": "default",
  "response_format": "wav",
  "stream": false,
  "ref_audio": "data:audio/wav;base64,...",
  "ref_text": "參考聲音的逐字稿，可省略。"
}
```

送至 `POST /v1/audio/speech`，成功回傳 `audio/wav`。`ref_audio` 和 `ref_text` 都可省略，便使用零樣本合成；參考音訊可單獨提供來複製音色，有逐字稿時提供 `ref_text`。`voice` 使用 `default`，模型亦接受 `voxcpm2` 別名。初版只支援非串流 WAV，App 透過既有句子切分、預取與播放緩衝處理長文，播放速度由 App 處理。可傳入 `language`（`auto` 或 ISO 語言／locale），供共用 App 協定使用；此節點驗證後移除，VoxCPM2 自行從文字辨識語言。

輸入最多 4096 Unicode 字元，參考聲音最多 45 秒／8 MiB，只接受包含實際音訊的 PCM 或 float WAV data URI。Gateway 不接收 HTTP URL、檔案路徑、其他模型、額外推理參數或遠端參考內容，避免把引擎變成任意網路／檔案讀取器。請求最大 12 MiB，回應最大 64 MiB，預設最長 180 秒；取消 App 請求會取消 gateway 的引擎連線。超時、錯誤、斷線皆會釋放接納名額。引擎只在獨立 Docker 網路上提供服務；gateway 以固定長度 hash 比較驗證 key，對外使用 TLS，回應停用快取。

## 目標 NVIDIA 主機效能驗證

以下工具是營運者明確執行的效能實驗，沒有加入自動回歸測試或啟動時額外消耗 GPU。需要 Node.js 24，也可在支援 host networking 的 Linux Docker 容器內執行。它不輸出輸入內容、聲音或 key，支援 1–128 併發、最多 1024 個正式請求加兩次預熱，每次最長 180 秒。正式請求數不得小於並發數；測量客戶端也需有足夠記憶體同時接收 WAV。

```sh
node tts/scripts/benchmark.mjs --concurrency 1 --requests 8 --output artifacts/tts-c1.json
node tts/scripts/benchmark.mjs --concurrency 4 --requests 16 --output artifacts/tts-c4.json
node tts/scripts/benchmark.mjs --concurrency 8 --requests 24 --output artifacts/tts-c8.json
```

確認較低檔位的延遲及顯存符合需求後，再按 16、32、64、128 提高部署容量及實驗並發數。例如已部署為 128 時，可明確執行 `node tts/scripts/benchmark.mjs --concurrency 128 --requests 256 --output artifacts/tts-c128.json`。不要把這段操作說明當作已完成的 128 路實測結果。

請先建立 `artifacts` 目錄。遠端測量使用 `--url https://你的網域 --key-file 私密key檔案`；音色複製增加 `--ref-wav 參考.wav`，可選 `--ref-text-file 逐字稿.txt`。結果分開記錄預熱、p50/p95 延遲與 RTF、每秒產生的音訊秒數。此介面為完整 WAV 回應，first response byte 包含合成／緩衝等待，不能冒充串流的第一音訊延遲。`clientHardware` 只描述執行工具的主機，遠端測量還需另記服務器 GPU 和驅動。

macOS Docker 可驗證 gateway 映像、配置及認證行為，但不能驗證這個 Linux NVIDIA 引擎的實際合成、顯存或速度。本次開發環境沒有 NVIDIA GPU，沒有聲稱完成硬體效能驗證。

## 上游依據

- [vLLM-Omni v0.30.0 release](https://github.com/vllm-project/vllm-omni/releases/tag/v0.30.0)
- [固定 release 的 VoxCPM2 部署設定](https://github.com/vllm-project/vllm-omni/blob/a8576ccb725c4e21cd13c3eb5f9a546b21149d2b/vllm_omni/deploy/voxcpm2.yaml)
- [官方 CUDA 安裝與 Docker 說明](https://github.com/vllm-project/vllm-omni/blob/v0.30.0/docs/getting_started/installation/gpu/cuda.inc.md)
- [官方 VoxCPM2 recipe](https://github.com/vllm-project/vllm-omni/blob/main/recipes/OpenBMB/VoxCPM2.md)（其舊版測量不能視為本部署實測）
- [VoxCPM2 固定模型 revision](https://huggingface.co/openbmb/VoxCPM2/tree/32279effe8c19989596f05d353d1447f51d9e915)
- [NVIDIA CUDA 相容性文件](https://docs.nvidia.com/deploy/cuda-compatibility/)
