# GPU gateway 交付驗證（2026-10-21）

- Node.js 24 gateway Docker 映像建立成功。
- GPU 與公開 HTTPS Compose 合併配置驗證通過；配置檢查使用範例網域，未啟動公開服務。
- 使用獨立 Docker 網路和模擬引擎，18 項檢查通過：API key、模型就緒狀態、WAV 轉送、語言欄位、拒絕 URL／檔案參考、模型限制、大小限制、併發限制、取消與逾時釋放。
- 驗證不使用真實文件、聲音或營運金鑰；容器及臨時網路已清除。
- 執行主機為 Mac，沒有 NVIDIA GPU。未驗證 Linux GPU 映像啟動、真實語音品質、顯存、RTF 或最佳吞吐量。不能將模擬結果當作 NVIDIA 效能證據。

營運者在目標 Linux NVIDIA 主機執行 [部署與效能驗證步驟](README.zh-Hant.md)，並保留 GPU／驅動版本及 1、4、8 併發結果。正式對外提供服務前仍需完成此項驗收。
