# 節點部署與驗證

本倉庫是 ATS 共享網路的可執行原型。檔案由節點營運者保存，App 營運者無須集中保存文檔；實際硬碟、頻寬與保存費用仍由節點或贊助者承擔。

## 本機啟動

安裝 Docker Desktop 或 Docker Engine 與 Compose，然後執行：

```sh
git clone https://github.com/JohnFinder/ats-network-node.git
cd ats-network-node
cp .env.example .env
docker compose up -d --build
```

預設只監聽本機 `http://127.0.0.1:8787`。在 ATS 的共享網路入口設定此地址並明確開啟「本機 HTTP」即可用於開發；實體手機不能用它連到電腦上的服務。本機開發地址不會自動變成公共服務。

節點資料保存在 Docker volume，重建容器不會清除。請勿使用 `docker compose down -v` 刪除正式節點資料。

## 公開 HTTPS 節點

準備指向主機的網域與可連入的 80/443 埠，在 `.env` 加入 `NODE_DOMAIN=你的網域`，設定適合主機容量的配額，再執行：

```sh
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

Caddy 會嘗試簽發 TLS 憑證。這需要真實 DNS、網路與憑證機構可達；本機驗證不代表公共 HTTPS 已驗證。公開服務啟動前應先決定接收政策、容量預算、管理員、備份與濫用處理方式。

將實際 `https://你的網域` 配置為 ATS 的 `ATSCommunityNodeURL` 後，該版本的一般使用者不用自行填節點地址。未配置部署網址的版本會如實顯示設定入口。

## 上載、搜尋與私人檔案

ATS 匯出完成後選「上載到節點」，可選公開共享、僅連結或私人保存。預設保留現有檔案加密，密鑰由用戶另外保存與分享，不傳給節點。

上載任務使用固定快照與 8 MiB 分段，可暫停及重新開啟 App 後恢復。公開檔案完成大小、雜湊及容器標記校驗後自動進入該節點列表。下載次數與熱度是此節點觀測值，不代表全網統計，不會自動發幣。

## Docker 驗證

需要主機 Node.js24以上，以產生無個人資料的測試檔：

```sh
node scripts/verify-node.mjs prepare
docker compose restart node
node scripts/verify-node.mjs resume
```

腳本預設驗證埠為18787；若沿用8787，兩次 node 指令都要加上 `NODE_URL=http://127.0.0.1:8787` 前綴。測試狀態保存於 `/tmp/ats-network-verification-state.json`，內含一次性測試身分，不應提交。

要驗證節點證據與本機鏈結算，從上述狀態檔取得 `publicResourceID` 及 `providerID`，分別設定環境變數 `NODE_RESOURCE_ID` 與 `EXPECTED_NODE_ID`：

```sh
docker compose -f compose.yaml -f compose.chain.yaml up -d --build node chain
docker compose -f compose.yaml -f compose.chain.yaml run --rm verify-chain
```

本機鏈 chainId為1337，預設 RPC只綁定127.0.0.1:18545。合約驗證會新部署固定供給測試代幣，驗證抵押、預付服務、贊助任務、延遲與防重複獎勵。該代幣無價值，不是正式發行，不應充值真實資產。

## 現階段與下一步

已實作：單節點儲存、上載續傳、公共列表、App整合、本機鏈獎勵會計與部署工具。

正式上線前仍需：公共主機與網域、實際節點維護者與預算、選定公鏈、獨立合約審計、多節點觀測及錢包綁定。首次公開發布不會自動在真實區塊鏈登記或領幣；目前只有可重現的本機鏈驗證。詳細階段見 `docs/PLAN.md`，安全邊界見 `docs/THREAT-MODEL.md`。

也可以直接執行 `./scripts/verify-docker.sh`。它會建立獨立容器、產生測試檔、重啟驗證續傳，再串接本機鏈結算；預設完成後只清除此驗證建立的容器和資料卷。需要 Docker/Compose 與 Node.js24以上，預設驗證埠為18788及18546。
