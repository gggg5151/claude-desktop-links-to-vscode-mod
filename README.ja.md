# claude-desktop-links-to-vscode-mod

Claude デスクトップアプリ用の [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview)。
**回答にあるファイル参照を押すと、VS Code でそのファイルのその行が開く。**

<!-- TODO: デモ GIF -->

デスクトップアプリの Code タブでは、回答が `src/server.ts:42` のようなリンクでファイルを示す。押すとアプリ内のファイル表示が開くだけで、SSH セッションには自分のエディタへ渡す「Open in」も出ない。この mod を入れると、クリックが、いま開いている VS Code のウィンドウへ向かう。

- **Remote-SSH**: そのファイルを含むフォルダを開いているウィンドウで開く。
- **ローカル**: macOS と Linux で、`code` コマンドを使う。
- **Markdown プレビュー**: プレビュー中の Markdown は、プレビューのまま該当行へ移動する。
- Web のリンク、画像、フォルダ、存在しないパスは、元の動作のまま。

[English](README.md) · [仕組み](docs/how-it-works.ja.md)

## 導入

必要なものは、デスクトップアプリの Code タブ（Claude Code v2.1.287 以降）、VS Code 1.90 以降、`bash`。
以下は、セッションが動くマシンで行う。SSH セッションならリモート側。

1. ファイルを置く。

   ```bash
   git clone https://github.com/gggg5151/claude-desktop-links-to-vscode-mod.git ~/.claude/mods/links-to-vscode
   ```

2. mod を読み込ませる。`~/.claude/settings.json` に次を足す。

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/links-to-vscode"
     }
   }
   ```

3. Markdown プレビューの移動を使うなら、VS Code のウィンドウを開いた状態で、同梱の VS Code 拡張を入れる。

   ```bash
   bash ~/.claude/mods/links-to-vscode/scripts/install-vscode-extension.sh
   ```

4. 新しいセッションを始めて、ファイル参照を押す。

mod は利用者の権限で動く。`claude plugin validate ~/.claude/mods/links-to-vscode` を実行すると、この mod が何に割り込み、何を呼ぶかを、動かさずに一覧できる。

## 既知の制約

- セッションが動くマシンが Windows の場合は対応していない。
- 読めるファイルなら `.env` を含めてどれでも開ける。画面共有中は注意する。
- VS Code に届かないときは通知が出るだけで、アプリのファイル表示は開かない。
- Remote-SSH のウィンドウが複数あるとき、パスに空白・非 ASCII 文字・`+` を含むフォルダは一致しないことがある。そのときはいちばん新しいウィンドウを使う。
- Markdown プレビューの移動では、テキストのタブが一瞬見える。
- ウィンドウ選びは VS Code の内部仕様に頼るため、VS Code の更新で動かなくなることがある。

すべての制約は [仕組み](docs/how-it-works.ja.md#制約) にある。

## ライセンス

[MIT](LICENSE)
