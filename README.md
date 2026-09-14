# BC Party Games

## 0.3.1 牌桌與萬用牌

- 參考社交撲克的牌桌層次：綠色絨布、金色桌緣、深色座位資訊卡、目前玩家高亮與獨立手牌區。十人桌採兩排座位，避免名字與手牌數擠在同一列。
- 一般萬用牌使用四色轉盤，只變色；+4 萬用牌使用四色扇形牌組與角落 +4，選色畫面也會說明效果。
- 罰牌結果隨狀態同步，顯示實際被罰玩家與抽牌數。疊加模式顯示累計罰牌及「承受罰牌 +N」按鈕；開啟疊加時，不會在 +4 打出瞬間立即抽牌。
- 新增 +4 雙人／多人、客端出牌同步、累計 +8、最後一張 +4 與回收牌庫測試。目前未重現使用者回報的漏罰 4 張；新增的結果提示用於直接確認實際抽牌，而非將未重現的問題標為已修復。

視覺參考：[Zynga Poker 官方遊戲頁](https://www.zynga.com/games/zynga-poker/)、[官方遊戲畫面](https://www.zynga.com/about/our-story/)。牌面以 Canvas 自行繪製，沒有引用遊戲圖片素材。

## 0.3.0 更新

- 深色卡片式等候室、可捲動玩家名單、手機單欄規則面板與鍵盤焦點／Escape 操作。
- 玩家頭像直接裁切同房玩家已繪製的人物 Canvas，不依賴其他插件、不讀取共享頭像、不發送網路請求。首次顯示時擷取，之後僅在外觀同步或人物 Canvas 重建事件後更新對應玩家；沒有定時重抓。人物尚未繪製完成時保留舊頭像或顯示姓名縮字，離房後清除快取。

### ModSDK hooks

- `ChatRoomMessage`（priority 2）：處理本插件 Hidden 封包，其他訊息交回原函式。
- `LoginResponse`（priority 0）：僅未登入時暫掛，登入完成即解除。
- `ChatRoomSyncSingle`、`ChatRoomSyncItem`、`ChatRoomSyncExpression`、`ChatRoomSyncPose`（priority 0）：原函式執行後標記被更新角色的頭像需更新；採角色／物品目標編號，不把操作發送者當成目標。
- `CharacterLoadCanvas`（priority 0）：人物繪製完成後更新該同房角色，涵蓋延遲載入及本機外觀變動。微任務合併同一輪更新；面板關閉時只記錄待更新狀態。
- 頭像 hooks 在插件銷毀時解除；不存在的 BC 函式不掛 hook。
- 主持人可在等候室持續邀請同房插件玩家；顯示傳送／等待狀態，2 秒重送、最多 3 次送達嘗試，邀請 60 秒到期。接受後會重試加入，10 秒未確認則提示失敗。
- 加入後確認規則並按「已準備」。主持人修改規則會重設其他人的準備狀態，所有玩家準備後才能開始。
- 規則：起始 3–9 張、回合 15–120 秒、重連 15–180 秒、投票 15–120 秒、投票冷卻 30–600 秒；同類罰牌疊加、抽到可出、剛抽牌可立即出、有牌必出、嚴格 +4。
- 修正重開牌局同步、抽牌後逾時、離開後重開、等候室離線成員清理、空牌庫卡局、全員離開無限迴圈、初始牌的效果與開發模組載入順序。
- 拒絕未受邀加入、無關牌局覆蓋、非玩家投票、偽造主持人讓渡；本機錯誤即時顯示，聊天通知中的玩家文字經 HTML 跳脫。

### 規則細節

同類疊加僅允許 +2 接 +2、+4 接 +4，不能混疊。承受罰牌後結束回合。嚴格 +4 會禁止仍有目前顏色手牌的玩家主動打出 +4，但允許疊加回應；這是出牌限制，不是「質疑 +4」流程。最後一張罰牌會先讓下一位抽取累計罰牌，再結束牌局。抽到可出在牌庫耗盡時停止；無可抽牌時跳過回合。逾時會抽牌並結束回合，已抽牌者直接結束回合，即使啟用有牌必出亦如此。

搶出、7–0 換手與手動喊 UNO 尚未實作，不提供設定開關。所有參與者建議更新至 0.3.0，舊版不支援準備確認及新增規則。

### 同步限制與驗證

目前沿用主持人權威與完整狀態廣播，以保留斷線接管能力。介面只顯示自己的手牌，但其他手牌仍存在接收端記憶體與聊天室 Hidden 封包，**不是防作弊或私密手牌協定**。若要做競技、麻將或含秘密資訊的遊戲，需先設計個別手牌傳送與可驗證／可信任的主持人接管機制。

`npm run check` 執行語法檢查與規則／控制器測試。`tests/browser-smoke.mjs` 使用 Playwright 與本機 Edge，涵蓋十人名單、邀請、規則變更、準備狀態、390px 寬度、牌桌及結束操作；可設定 `PLAYWRIGHT_MODULE` 指向已安裝的 Playwright 套件。截圖寫入 `tests/ui-*.png` 並由 Git 忽略。這些是模擬測試，尚未在真實 BC 聊天室進行跨帳號驗證。

新功能提案見 [遊戲擴充方向](docs/game-roadmap.md)。

Modular multiplayer party games for Bondage Club. The first included game is classic UNO.

## Current features

- One installable userscript, built from modular source files.
- 2–10 player classic 108-card UNO.
- Room lobby, join/start flow, host-authoritative actions, full-state synchronization.
- Visible card counts for every player; only the local hand is rendered face-up.
- Automatic UNO announcement when a player reaches one card.
- 60-second reconnect window and deterministic host takeover.
- Voluntary host transfer.
- One-minute restart/end votes with strict majority and per-proposer five-minute cooldown.
- Shared Liko `BC_i18n` engine with Traditional Chinese, Simplified Chinese, and English placeholders.
- Canvas-rendered cards with a replaceable rendering layer.

## Build and test

```text
npm run build
npm run check
```

The installable result is `dist/BC-PartyGames.user.js`.

For local development, set these page globals before loading the userscript:

- `window.BCPartyGamesDevBase`: URL root of this repository.
- `window.LikoDevBase`: URL root of the `liko-Plugin-Repository/Plugins/` directory.

## Structure

- `src/core.js`: pure UNO deck and rules.
- `src/transport.js`: BC Hidden-message protocol.
- `src/controller.js`: lobby, authority, reconnect, host transfer, and voting.
- `src/ui.js`: Canvas table and controls.
- `src/main.js`: BC integration and shared-system loading.
- `Translation/PartyGames-i18n.js`: shared i18n namespace strings.
