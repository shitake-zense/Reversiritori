# Reversiritori

2人で言葉をつなぎ、8×8の盤面で得点を競うWebゲームです。招待コード・URLと、辞書ON/OFF別の公開マッチングがあります。Next.js App Router、Supabase Auth/Database/Realtime、Vercelで動きます。

公開版: https://reversiritori.vercel.app/

## ルール

- 中央の中立開始語から始め、先手をランダムに決めます。双方の準備完了後、交互に合計20手（各10手）、1手20秒です。盤面の外枠が残り時間に合わせて減ります。
- 通常は2〜4文字のひらがな語を入力し、上下左右・斜めの8方向に伸ばします。語頭は直前の語尾マスと表記上同じ仮名です。既存マスは文字が違っても通過でき、盤面の仮名・所有色は変わりません。最後の文字は必ず空マスに置きます。空マスになった経路上の文字は自分の色になります。直前の経路は盤面の点線で確認できます。
- 得点は現在所有するマス1個につき3点、試合で初めて使った仮名に0.5点、濁音・半濁音を使うたび0.8点です。語頭の共有マスと長音符には文字ボーナスは付きません。既存マスを通過した文字には文字ボーナスが付きますが、マス確保点は付きません。
- 新しい仮名を使うと、得点と別に文字解放ポイントを2p獲得します。5pで共有語頭の清音・濁音・半濁音を変換、7pで5〜6文字の言葉、10pで経路上の相手マスの文字・所有色を上書きできます。1手で選べるスキルは1種類です。ポイントを使っても得点は減りません。スキル使用時も最後の文字は空マスに置きます。
- 1手戻る・試合の中断・引き分け終了は相手の承認が必要です。中断中は時計が止まり、再開も相手の承認を要します。提案は30秒で期限切れとなり、拒否・撤回・期限切れでは残っていた時間から手番を再開します。
- 単語の再使用、末尾「ん」、時間切れ、合法手なしは負けです。不正な入力、辞書不掲載、盤外、最後が空マスでない配置は確定せず再入力できます。20手終了時は高得点側が勝ち、同点は引き分けです。
- 辞書ONはMeCab IPAdicの一般名詞、OFFは形式と盤面のみを確認します。開始後に切替できません。挟み反転はありません。

## ローカルセットアップ

1. Node.js 20.9以降とnpmを用意し、`npm ci` を実行します。
2. Supabaseで東京リージョンのプロジェクトを作り、**Authentication → Sign In / Providers** で **Allow anonymous sign-ins** を有効にします。
3. `.env.example` を `.env.local` にコピーします。Project URLはDashboardの **Connect** または **Integrations → Data API**、Publishable keyとSecret keyは **Settings → API Keys** で確認して設定します。URLは `https://<プロジェクトID>.supabase.co` の形です。Secret keyはサーバー専用です。値をGitやチャットへ貼らないでください。
4. 新規環境では `supabase/migrations/20260929000000_initial.sql`、続いて `supabase/migrations/20260930000000_match_controls.sql` をそれぞれ1回適用します。既存環境では未適用の後者だけを実行します。GitHub Integration の **Deploy to production がOFF** の場合はSupabase DashboardのSQL Editorで実行し、同じSQLを二重適用しないでください。将来Deploy to productionをONにする場合は、既存マイグレーションの履歴を先に整合させます。
5. `npm run dev` で起動します。異なるブラウザプロファイルを2つ使うと匿名ユーザーを分けられます。

接続の確認には `node --env-file=.env.local scripts/check-connection.mjs` を実行します。認証とテーブルの状態コードだけを表示し、キーやトークンは出力しません。DB適用後の招待対戦・権限・同時着手・公開マッチの確認には、開発サーバーを起動してから `node --env-file=.env.local scripts/check-live.mjs` を実行します。20手完走の確認には `node --env-file=.env.local scripts/check-full-game.mjs` を使います。これらの確認は匿名のテストユーザーと試合をDBに作成します。

マイグレーションでは試合と公開待機列を保存し、参加者だけに試合のSELECTを許すRLSとRealtime publicationを設定します。書込みはサーバーAPI専用です。接続が切れても画面は定期的にAPIから状態を再取得します。公開待機は2分で期限切れになり、マッチ後も2分間は成立した部屋を取得できます。待機相手がいなければ招待部屋を作れます。短い切断・再読込後は同じ匿名セッションと部屋URLから復帰できます。ブラウザデータ消去後の復旧は対象外です。

## Vercel公開

1. Vercelの **New Project** でGitHubの `shitake-zense` スコープを選び、このリポジトリをImportします。スコープが出ない場合は **Add GitHub Scope** で対象アカウントを接続します。
2. **Project Settings → Environment Variables** に `.env.example` の3変数を設定します。Secret keyに `NEXT_PUBLIC_` を付けないでください。
3. `vercel.json` はFunctionsを東京 `hnd1` に指定しています。Vercelの **Settings → Functions → Function Regions** でも東京を確認します。
4. 環境変数を変更したら再デプロイし、公開URLを別端末2台で開いて試合を確認します。

## 辞書とライセンス

`npm run dictionary:build` はMeCab IPAdicの `Noun.csv` の「名詞/一般」から読みを抽出します。元データはコミット `61b90ba6e669dc2d7d533d4a80d206f3b31d52b1` に固定しています。`Noun.verbal.csv`、`Noun.adjv.csv`、動詞は使いません。2〜6文字で語頭と語尾が盤面ルールに合う語に絞り、重複を取り除きます。通常の手は2〜4文字、5〜6文字はスキル専用です。生成済み辞書は30,158語（通常20,269語・拡張9,889語）で、`src/data/words.json` と `src/data/dictionary-stats.json` に保存します。元データ・ライセンスは [MeCab IPAdic](https://github.com/taku910/mecab/tree/61b90ba6e669dc2d7d533d4a80d206f3b31d52b1/mecab-ipadic) を参照し、公開物に [IPADIC-COPYING.txt](public/IPADIC-COPYING.txt) を同梱します。

## 検証

- `npm test`、`npm run build`
- 2026-09-29、初回版の本番URLに対して `node --env-file=.env.local scripts/check-live.mjs https://reversiritori.vercel.app` と `node --env-file=.env.local scripts/check-full-game.mjs https://reversiritori.vercel.app` が成功。招待、参加者以外の閲覧制限、準備完了、同時着手、辞書モード別の公開待機列、20手の決着を確認しました。改修版の検証結果は公開後に追記します。
- `npm run simulate -- 200` と `npm run simulate -- 200 short` で辞書ONの自動対局を比較します。20秒以内の人間の回答率は実機試遊で測る必要があります。

## 操作

部屋を作ってURLを共有するか、同じ辞書モードで公開マッチへ入ります。双方で「準備完了」を押すと時計が始まります。単語を入力し、語頭を囲む8方向の矢印で方向を選び、配置プレビューを見て確定します。語尾は金色の枠、直前の経路は点線で示します。使用済みの仮名と濁音は盤面の周囲に表示されます。右上の「遊び方 ?」からルールとスキルの説明を開けます。
