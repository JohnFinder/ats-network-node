# ATS Network Node

供獨立營運者部署的有聲書儲存、簽署目錄探索及可選 NVIDIA 語音合成節點。節點提供 ATS `.atsbook` 傳輸介面，營運者自行設定容量、對等節點、憑據與部署環境。

[English](README.md) · [部署與升級](docs/DEPLOYMENT.md) · [GPU／VoxCPM2 指南](tts/README.zh-Hant.md) · [Apache-2.0](LICENSE)

本倉庫只包含節點服務代碼，不包含 ATS Apple App、使用者資料、私密配置、Docker 映像或模型權重。

## 主要功能

- 8 MiB 分段續傳、重啟恢復、完整大小及 SHA-256 校驗。
- 公開、僅連結及私人檔案，Ed25519 發布者認證與持久化防重放。
- 搜尋、HTTP Range 下載、容量配額、持久節點身分及備份／還原工具。
- 釘選對等節點身分、簽署目錄交換、公開副本、來源回退、修補與退出模式。
- 可選 VoxCPM2 TTS 與參考音訊音色複製，使用帶 API key 的 OpenAI 相容語音介面。
- 語音並發配置範圍 **1–128**，預設 **8**，可透過環境變量或 YAML 部署參數控制。
- 可選 EVM 合約、獨立索引／觀測／結算服務，以及 Filecoin Synapse 適配器。

檔案雜湊不代表內容權利認證；節點簽署聲明不代表獨立實體副本。下載數不自動產生代幣獎勵，付費服務需另外設定資金、合約及營運環境。

## 首次部署

安裝 Docker 與 Compose V2，取得代碼：

```sh
git clone https://github.com/JohnFinder/ats-network-node.git
cd ats-network-node
cp .env.example .env
```

純儲存節點執行 `docker compose up -d --build`。預設僅監聽 `127.0.0.1:8787`，資料與節點身分保存在 `node-data` volume。

Linux x86_64 NVIDIA 主機完成驅動、Container Toolkit 與 GPU 容量配置後，執行：

```sh
sh scripts/start-gpu-node.sh
```

此工具建立儲存、語音 Gateway 及私有推理引擎，缺少 API key 時才產生新 key。Gateway 預設監聽 `127.0.0.1:8791`，引擎不公開主機埠。公開 HTTPS 部署先設定 `NODE_DOMAIN`、DNS 與 80/443 埠，再使用 `sh scripts/start-gpu-node.sh --public`。

既有節點應保留 `.env`、`secrets/`、Compose project 名稱、資料 volume、模型快取與 YAML 調校值，按[升級流程](docs/DEPLOYMENT.md#upgrading-an-existing-node)更新；不要以範本覆蓋既有憑據或刪除 volume。

## 128 並發配置

在 `.env` 設定：

```dotenv
TTS_MAX_CONCURRENT=128
```

會同步設定 Gateway 接納數、引擎 `max_num_seqs` 及 unified decode graph 批次容量。`TTS_CUDA_GRAPH_MAX_BATCH_SIZE` 可另設較小的 graph 上限；也支援 YAML 引擎配置。非空環境變量優先，完整範例見[部署並發參數](tts/README.zh-Hant.md#部署並發參數)。變更後需重新建立 Gateway 和引擎容器。

滿額時 Gateway 回傳 `429`／`Retry-After: 2`。**128 是軟體可配置上限，尚未完成目標 GPU 的 128 路效能驗證。** 範本 KV 預算仍為 6 GiB，並發提高不會自動放大它；CFM、AudioVAE、graph 池及其他 GPU 服務亦使用顯存。需按實際句長、參考音訊與硬體調整容量。Gateway 的記憶體與 CPU 額度亦可在 `.env` 設定。

## 文件入口

| 文件 | 內容 |
| --- | --- |
| [快速入門](docs/QUICKSTART.zh-Hant.md) | 純儲存、GPU 與公開 HTTPS 部署 |
| [部署手冊](docs/DEPLOYMENT.md) | 升級、回退、憑據與故障排查 |
| [GPU 指南](tts/README.zh-Hant.md) | 硬體需求、固定版本、並發及 TTS API |
| [協定參考](docs/PROTOCOL.md) | 儲存配置、認證、續傳與簽署目錄 |
| [營運手冊](docs/OPERATIONS.md) | 備份／還原、節點退出、觀測與結算 |
| [驗證紀錄](docs/VALIDATION.md)／[GPU 驗證紀錄](tts/VALIDATION.md) | 已做與未做的檢查範圍 |
| [合約](contracts/README.md)／[獨立服務](services/README.md)／[Filecoin](storage/README.md) | 可選組件與各自配置 |
| [版本變更](CHANGELOG.md)／[貢獻指南](CONTRIBUTING.md)／[安全回報](SECURITY.md) | 維護與協作 |

GitHub 驗收工作流程只接受手動觸發，推送及 PR 不會自動建置或測試。既有紀錄只適用於記錄的版本與環境，不能代表新版或目標硬體已通過驗證。

## 授權

專案自有代碼與文件採用 **Apache License 2.0**，見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。依賴、容器映像及模型權重保留各自的上游授權，詳見[第三方組件說明](THIRD_PARTY_NOTICES.md)。
