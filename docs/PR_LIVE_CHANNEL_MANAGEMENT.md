# Pull Request: LIVE パネル カスタムチャンネル管理

## 1. プルリクエストの作成手順

ブランチは **myfork** に push 済みです。以下のいずれかで PR を作成してください。

- **方法A**: ブラウザで  
  **https://github.com/koala73/worldmonitor/compare/main...Niboshi-Wasabi:feat/live-panel-customize**  
  を開き、「Create pull request」をクリックする。
- **方法B**: https://github.com/Niboshi-Wasabi/worldmonitor を開き、画面上部の「Compare & pull request」バナーから、ベースリポジトリを `koala73/worldmonitor`・ベースブランチを `main` に指定して PR を作成する。

---

## 2. PR 用タイトル・本文（コピー用）

### タイトル
```
feat(live): custom channel management — add/remove/reorder, standalone window, i18n
```

### 本文（Description）
```markdown
## Summary
LIVE パネルで表示するチャンネルをユーザーが追加・削除・並び替えできる機能を追加しました。スタンドアロンのチャンネル管理画面と、パネル内の歯車アイコンからの遷移をサポートしています。

## Changes
- **Standalone channel management window** (`?live-channels=1`): チャンネル一覧・追加フォーム・「デフォルトを復元」ボタン
- **LIVE パネル**: 歯車アイコンでチャンネル管理を開く / チャンネルタブのドラッグ＆ドロップで並び替え
- **編集**: 行クリックでインライン編集（ハンドル・表示名・削除・保存・キャンセル）
- **確認ダイアログ**: 削除時は `window.confirm` ではなくカスタムモーダルを使用
- **i18n**: 全ロケールに `manage`, `addChannel`, `youtubeHandle`, `displayName`, `confirmTitle`, `confirmDelete`, `remove`, `save`, `cancel`, `restoreDefaults`, `channelSettings` 等を追加
- **UI**: チャンネル管理画面で「チャンネル一覧」と「チャンネル追加」フォームの間に余白を追加
- **その他**: settings-window のコメントを英語表記に統一

## Screenshots
以下の6枚を PR に上から順に貼り付けてください。（重複していた「チャンネル管理の別アングル」「復元ボタン単体」を1枚にまとめています。）

1. **LIVE パネル（通常表示）** — チャンネルタブと右上の歯車アイコン
2. **チャンネル管理画面** — 一覧・「Add channel」フォーム・余白（復元ボタンが出ていれば写す）
3. **削除確認モーダル** — 「Delete this channel?」と Cancel / REMOVE ボタン
4. **編集モード（プリセット）** — ビルトインチャンネルを選択したときの Remove / Save / Cancel
5. **編集モード（カスタム）** — 自分で追加したチャンネル（例: @ntv_news）のハンドル・表示名入力と Remove / Save / Cancel
6. **チャンネルタブの改行** — LIVE パネルでタブが2行に折り返した状態

## Testing
- [ ] LIVE パネルで歯車アイコンからチャンネル管理を開ける
- [ ] `?live-channels=1` でスタンドアロン管理画面が開く
- [ ] チャンネルの追加・削除・並び替えが保存され、パネルに反映される
- [ ] デフォルト復元ボタンが不足時のみ表示され、クリックで復元される
- [ ] 削除確認モーダルでキャンセル・削除が動作する
```

### 本文（English）
```markdown
## Summary
Users can add, remove, and reorder the channels shown in the LIVE panel. A standalone channel management view and a gear icon inside the panel are provided to access it.

## Changes
- **Standalone channel management window** (`?live-channels=1`): Channel list, add form, and “Restore default channels” button.
- **LIVE panel**: Gear icon opens channel management; channel tabs can be reordered by drag and drop.
- **Editing**: Row click opens inline edit (handle, display name, remove, save, cancel).
- **Confirmation dialog**: Delete is confirmed with a custom modal instead of `window.confirm`.
- **i18n**: Added strings for all locales: `manage`, `addChannel`, `youtubeHandle`, `displayName`, `confirmTitle`, `confirmDelete`, `remove`, `save`, `cancel`, `restoreDefaults`, `channelSettings`, and related keys.
- **UI**: Extra spacing between the channel list and the “Add channel” form on the channel management screen.
- **Other**: Standardized settings-window comments to English.

## Screenshots
Paste the 6 screenshots below in order. (Consolidated duplicate “channel management” views and “restore button” into a single shot.)

1. **LIVE panel (default)** — Channel tabs and gear icon
2. **Channel management** — List, “Add channel” form, and spacing (include “Restore default channels” button in frame if visible)
3. **Delete confirmation modal** — “Delete this channel?” with Cancel / REMOVE
4. **Edit mode (preset)** — Built-in channel selected; Remove / Save / Cancel visible
5. **Edit mode (custom)** — Custom-added channel (e.g. @ntv_news): handle, display name, Remove / Save / Cancel
6. **Channel tabs wrap** — LIVE panel with tabs wrapping to two rows

## Testing
- [ ] Channel management opens from the gear icon in the LIVE panel
- [ ] Standalone management view opens at `?live-channels=1`
- [ ] Add / remove / reorder channels persist and are reflected in the panel
- [ ] “Restore default channels” is shown only when some built-in channels are missing; click restores them
- [ ] Delete confirmation modal: Cancel and Remove both work as expected
```

---

## 2.5 PR テンプレートのチェック例

本 PR でチェックすべき項目です。PR 作成時にテンプレートが出た場合は以下を参考にしてください。

### Type of change
- **[x] New feature**

### Affected areas
- **[x] News panels / RSS feeds**（LIVE パネルが対象のため）
- **[x] Config / Settings**（チャンネル保存・復元、settings-window のコメント変更があるため）

上記以外（Map/Globe、AI Insights、Market Radar、API、Desktop 専用変更など）は該当しないためチェック不要です。

### Checklist
- **[x] Tested on [worldmonitor.app](https://worldmonitor.app) variant**
- **[x] Tested on [tech.worldmonitor.app](https://tech.worldmonitor.app) variant (if applicable)**（LIVE パネルは tech にもあるため、可能ならチェック）
- **[ ] New RSS feed domains added to `api/rss-proxy.js` allowlist** — 該当なし（新規 RSS フィードは追加していない）
- **[x] No API keys or secrets committed**
- **[x] TypeScript compiles without errors (`npm run typecheck`)**（未確認の場合は `npm run typecheck` を実行してからチェック）

---

## 3. 開発者向け — 今回の機能追加のまとめ（開発完了報告用）

### 実装した機能一覧

| 項目 | 内容 |
|------|------|
| **チャンネル管理ウィンドウ** | URL `?live-channels=1` で開くスタンドアロン画面。チャンネル一覧・追加フォーム・「デフォルトを復元」を表示。 |
| **LIVE パネルからの入口** | パネル右上の歯車アイコン（ツールチップ: "Channel Settings"）クリックでチャンネル管理を開く。 |
| **チャンネル一覧** | 各チャンネルはボタン風の行で表示。クリックで編集モードに切り替え。 |
| **編集** | 行クリックでインライン編集（カスタムは YouTube ハンドル・表示名、ビルトインは表示名のみ）。保存・キャンセル・削除ボタン。フォーム内の input/button クリックでは編集モードが開かないようガード。 |
| **削除確認** | 削除時は `window.confirm` を使わず、カスタムモーダル（タイトル・メッセージ・キャンセル/削除）で確認。 |
| **並び替え** | 一覧の行をドラッグ＆ドロップで並び替え。`dragend` で順序をストレージに保存。 |
| **チャンネル追加** | ハンドル（例: @Channel）と表示名（任意）を入力して追加。重複 ID は追加しない。 |
| **デフォルト復元** | ビルトインチャンネルで現在リストにないものがあるときだけ「Restore default channels」を表示し、クリックで一覧に復元。 |
| **多言語対応** | 上記で使う文言を全ロケールに追加（`components.liveNews` 配下）。`t()` とフォールバックを統一。 |
| **UI 調整** | チャンネル管理画面で、チャンネル一覧と「チャンネル追加」フォームの間に余白（例: 20px + 親 gap）を追加。 |

### 主な変更ファイル

- `src/live-channels-window.ts` — 新規。チャンネル管理ウィンドウの初期化・一覧描画・編集フォーム・確認モーダル・復元・追加処理。
- `src/components/LiveNewsPanel.ts` — 歯車ボタン・チャンネル管理への遷移・チャンネルボタン共通化・`getDefaultLiveChannels` の export 等。
- `src/App.ts` — `?live-channels=1` のときのルーティングで `initLiveChannelsWindow()` を呼び出し。
- `src/main.ts` — チャンネル管理用のエントリ（必要に応じて読み込み）。
- `src/styles/main.css` — モーダル・チャンネル管理リスト・復元ボタン・行 DnD・追加セクション余白などのスタイル。
- `src/locales/*.json` — `components.liveNews` に manage, addChannel, youtubeHandle, displayName, confirmTitle, confirmDelete, remove, save, cancel, restoreDefaults, channelSettings 等を追加。
- `src/config/variants/base.ts` — 必要に応じたパネル/チャンネル設定。
- `src/settings-window.ts` — コメントの英語表記（「表示させるパネルの設定」→ "panel display settings") に変更。

### 技術メモ

- チャンネル ID の生成: YouTube ハンドルから `customChannelIdFromHandle` で一意の ID（例: `@Foo` → `custom-foo`）を生成。
- ストレージ: 既存の `loadChannelsFromStorage` / `saveChannelsToStorage` を利用。順序は DnD 後に DOM から読み直して保存。
- 編集フォーム内クリックで親の行クリックが発火しないよう、`closest('input, button, textarea, select')` でガード。

---

## 4. スクリーンショットを撮影する場所

PR の Description やレビュー用に、以下の画面のスクリーンショットを撮影することを推奨します。

| # | 撮影場所 | 手順・補足 |
|---|----------|------------|
| 1 | **LIVE パネル（通常表示）** | アプリで LIVE パネルを開いた状態。チャンネルタブと、右上の**歯車アイコン（Channel Settings）**が写っていること。 |
| 2 | **チャンネル管理画面（一覧＋追加フォーム）** | 歯車をクリックするか、URL に `?live-channels=1` を付けてチャンネル管理を開いた状態。**チャンネル一覧**と**「Add channel」セクション**の両方、およびその間の余白が分かるようにする。 |
| 3 | **チャンネル行の編集モード** | チャンネル管理画面でいずれかのチャンネル行をクリックし、**編集モード**（ハンドル/表示名の入力欄・Remove / Save / Cancel）が表示されている状態。 |
| 4 | **削除確認モーダル** | 編集モードで「Remove」をクリックしたときの**カスタム確認モーダル**（タイトル・メッセージ・Cancel / Remove ボタン）が表示されている状態。 |
| 5 | **デフォルト復元ボタン** | ビルトインチャンネルをいくつか削除した状態でチャンネル管理を開き、**「Restore default channels」**ボタンが表示されているところ。（任意: 復元後の一覧のスクショもあるとよい） |

### 撮影時の注意

- ブラウザのウィンドウサイズは、実際の利用想定に近いサイズ（またはデフォルト）で撮影するとよいです。
- 多言語をアピールする場合は、日本語または英語以外のロケールで 1 枚あると説得力が増します。

---

## 5. ディスカッション用 — 開発完了報告（コピー用）

GitHub Discussions などで開発者に報告する際の文面です。PR #276 作成後の「開発完了報告」用にしています。

### 英語版（English）
```markdown
Hi,

The custom channel management feature for the LIVE panel is complete. I’ve opened a PR for review.

**PR:** https://github.com/koala73/worldmonitor/pull/276

I’m sorry for the delay in delivering this; I appreciate your patience.

---

**Summary of changes**
- Standalone channel management view (`?live-channels=1`) and entry from the gear icon in the LIVE panel
- Add, remove, and reorder channels (drag & drop); inline edit on row click (handle, display name)
- Custom confirmation modal for delete; “Restore default channels” button
- i18n for all locales; spacing between the channel list and the add form on the management screen

Details are in the PR description and in [docs/PR_LIVE_CHANNEL_MANAGEMENT.md](https://github.com/Niboshi-Wasabi/worldmonitor/blob/feat/live-panel-customize/docs/PR_LIVE_CHANNEL_MANAGEMENT.md). I’d be glad to address any review feedback.

I’m also ready to implement similar changes for the **LIVE WEBCAMS** panel (add/remove/reorder cameras). I can follow up with that once this PR is merged; if you have a preferred timeline, just let me know.
```
