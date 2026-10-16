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

## 多節點、錢包與獎勵

V2 已加入釘選節點身分的公開目錄交換、副本建立／修補與來源回退。先啟動節點取得指紋，核對後才加入 `NODE_PEERS`，公共環境使用 HTTPS。`compose.full.yaml` 是三節點開發示範，不能原樣當成公共部署。

區塊鏈服務與觀測器使用 `compose.services.yaml`，需提供已審核部署清單、RPC、節點指紋與各自密鑰／資料卷。App 的「錢包與收益」可建立雙證明綁定、開啟外部錢包登記與操作頁。外部錢包每次確認交易，不會把私鑰交給節點。營運者可用 `src/bind-wallet.mjs` 在節點內簽署綁定意向，無需複製私鑰。

儲存費依已預付期間與觀測結果結算，失敗部分退款；爭議會暫停結算等待解決。發布者任務可拆為分別出資的里程碑，保存獎勵可指定累積 30 天成功保存才解鎖。下載數與熱度不直接產生獎勵。

建議驗證順序：

```sh
./scripts/verify-docker.sh
./scripts/verify-mesh-docker.sh
./scripts/verify-backup-docker.sh
npm ci --ignore-scripts --prefix services
./scripts/verify-services-docker.sh
npm ci --ignore-scripts --prefix storage
npm --prefix storage run verify
```

驗證使用合成資料、本機測試鏈與無價值代幣，不操作個人文檔或正式資金。Filecoin 介面已提供，但實際付費上傳和證明週期需要外部資金及另行驗收。正式公共節點、獨立故障域、外部審計與內容授權審查仍是上線條件。

完整流程見 [操作手冊](OPERATIONS.md)、[開發階段](PLAN.md)、[合約](../contracts/README.md)、[獨立服務](../services/README.md) 與 [Filecoin 介面](../storage/README.md)。
