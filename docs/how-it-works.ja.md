# 仕組み

[English](how-it-works.md)

```
回答の文章 ──▶ hooks/register.tsx ──クリック──▶ scripts/open-in-vscode.sh ──▶ VS Code
               （ファイルへのリンクを書き換え）   （開くウィンドウを決める）        ▲
                                                        │ Markdown のときだけ        │
                                                        └──▶ Claude Open Bridge ────┘
                                                             （unix ソケット）
```

## 3つの部品

### `hooks/register.tsx`

デスクトップ画面でアシスタントの回答を描く処理に割り込む。リンク先が実在する通常ファイルである Markdown リンクを、押されたことを通知する `file://…#L<行>C<列>` のリンクに書き換える。インラインコードとコードフェンスの中は対象外。

対応する書き方は、`a.ts`、`a.ts:42`、`a.ts:42:7`、`a.ts:42-50`、`a.ts#L42`、`a.ts#L42C7-L50`。

### `scripts/open-in-vscode.sh`

パス・行・列を受け取る。

- **Remote-SSH のホスト**（`~/.vscode-server` がある）。待ち受け中の `vscode-ipc-*.sock` を列挙し、各ウィンドウの拡張ホストの隣にある remote CLI を見つける。VS Code はリモートのフォルダの保存領域に `md5("vscode-remote://<authority><パス>")` という名前を付けるので、ファイルの親フォルダを順にハッシュして、一致するウィンドウを探す。見つけたウィンドウのソケット経由で `code -r -g パス:行:列` を実行する。ウィンドウが1つだけの場合と、一致がない場合は、いちばん新しいウィンドウを使う。
- **ローカル**。`code -g パス:行:列` を実行する。開くウィンドウは VS Code が決める。

### `vscode-extension/`（Claude Open Bridge）

Markdown を担当する。標準のプレビューは外から行を指定できない。ただし、新しく開いたプレビューは、同じファイルの直近のテキストエディタで一番上に見えていた行から始まる。そこで拡張は次の順に動く。

1. プレビューと同じエディタグループで、ファイルをテキストとして開く
2. 目的の行を一番上までスクロールする
3. 古いプレビューを閉じる
4. 新しいプレビューを開く
5. 自分で開いたテキストのタブを閉じる（もともと開いていたものは残す）

各ウィンドウは `~/.cache/claude-open-bridge/<pid>.sock` で待ち受ける（ディレクトリは `0700`、ソケットは `0600`）。スクリプトは、そのファイルを含むフォルダをワークスペースに持つウィンドウへ `{path, line, column}` を送る。

拡張を入れた直後に移動が効かないときは、VS Code で「開発者: ウィンドウの再読み込み」を実行する。

## この mod が触れる範囲

`claude plugin validate` は、mod が何に割り込み、何を呼ぶかを、何も実行せずに一覧する。

```
❯ ./register.tsx hooks: session.start, command.run{command=open-in-vscode-install-extension}, ui.render{component=AssistantMessage}
❯ ./register.tsx calls: $.command.register, $.fs.stat, $.process.run, $.session.cwd, $.ui.resolve, $.ui.toast
```

リンク先がファイルかどうかを調べ（`$.fs.stat`）、クリックされたら `scripts/open-in-vscode.sh` を、`/open-in-vscode-install-extension` が打たれたら `scripts/install-vscode-extension.sh` を実行する（`$.process.run`）。ネットワークへのリクエストは行わない。

## clone を読み込ませる

marketplace から入れる代わりに、clone したフォルダを Claude Code に読み込ませることもできる。

```bash
git clone https://github.com/gggg5151/claude-desktop-links-to-vscode-mod.git ~/.claude/mods/links-to-vscode
```

そのフォルダを `~/.claude/settings.json` に書く。

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/links-to-vscode"
  }
}
```

この変数がすでにある場合は、`:` で区切って追記する。ターミナルのセッションなら `claude --plugin-dir ~/.claude/mods/links-to-vscode` で、そのセッションだけ読み込める。プラグインのインストールと clone の読み込みを同時にしないこと。同名のプラグインが2つになり、先に読み込まれたほうしか動かない。

## 何も開かずに設定を確かめる

```bash
OPEN_IN_VSCODE_DRY_RUN=1 bash scripts/open-in-vscode.sh /absolute/path/to/file.ts 42 1
```

実行するはずのコマンドが表示される。

## 制約

対応環境

- デスクトップアプリの WSL セッションはプラグインを読み込まない。素の Windows ではスクリプトが未検証。
- Remote-SSH かどうかは、Linux ホストの `~/.vscode-server` の有無で判定する。別の場所や別の名前で入っているサーバは検出しない。

ファイルを開く

- 実在して読めるファイルなら、`.env` を含めてどれでも開ける。開くのは自分のエディタの中だけ。
- VS Code に届かないときは通知が出るだけで、アプリのファイル表示には切り替わらない。
- Remote-SSH のウィンドウが複数あるとき、パスに空白・非 ASCII 文字・`+` を含むフォルダは一致しないことがある。そのときはいちばん新しいウィンドウを使う。
- ウィンドウ選びは VS Code の内部仕様に頼る（ソケットの名前、拡張ホストのログ、フォルダの保存領域の名前の付け方、`code --status` の文言）。どれかが合わないときは、通知なしでいちばん新しいウィンドウを使う。
- `OPEN_IN_VSCODE_DRY_RUN=1` でも、各ウィンドウへの `code --status` の問い合わせは行う。

Markdown プレビュー

- テキストのタブが一瞬見える。
- 切り替えが途中で失敗すると、プレビューが消えてテキストのタブが残る。
- 移動は、標準のプレビューが開始行を決める方法に頼る。
- 移動のあと、名前のないマルチルートワークスペースのウィンドウは前面に出さない。

リンクの書き換え

- コードとして扱うのは、インラインコードと、バッククォート3つまたはチルダのフェンスだけ。インデントで書いたコードブロックの中や、別のフェンスを含む長いフェンスの中のリンクは、書き換えることがある。
- あるパスが開けるファイルかどうかの判定結果は、セッションのあいだ保持する。
- 書き換え後の文章が1万文字を超える回答と、リンク先のファイル位置が256種類を超える回答は、書き換えない。

拡張のインストール

- VS Code の remote CLI は、インストールに失敗しても終了コード `0` を返す。そのためスクリプトは失敗時も「installed」と表示する。拡張機能ビューで確認すること。

## アンインストール

1. marketplace から入れた場合は `claude plugin uninstall open-in-vscode@links-to-vscode`。clone を読み込ませた場合は、`~/.claude/settings.json` の `CLAUDE_CODE_PLUGIN_DIRS` からフォルダを外して削除する。
2. `~/.cache/claude-open-bridge` を削除する。
3. VS Code の拡張機能ビューで **Claude Open Bridge** をアンインストールする。
