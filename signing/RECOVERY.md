# macOS 更新签名密钥恢复

适用身份：谷子助手 `cn.shilong.gooz` 的 Sparkle 正式 Ed25519 签名密钥，identity version 1，创建于 2026-10-26。恢复时必须保留同一密钥，才能继续给已安装应用提供可信更新。

**2026-10-26 已成功从 GitHub Actions 的现有签名密钥重建加密备份，并完成解密与签名验证。** 换机恢复首选下列新备份与新密码文件配对，不需要旧 Mac 的钥匙串。新密码不能解密旧 `.asc`。

Git 只允许保存加密备份和公开身份信息。明文密码使用 `*.local.*` 文件名，权限为 `0600`，必须被 Git 忽略；不要强制添加，也不要把整个 `signing/` 目录作为附件分享。**仅有 `.asc`，没有配套密码，无法恢复私钥。** 仓库中的加密备份、恢复工具和说明用于换机恢复；密码只在本机保存，不随仓库同步。

## 1. 当前备份与账户

| 内容 | 位置或名称 |
| --- | --- |
| 首选的新加密备份 | [guzi-assistant-sparkle-production-v1-recovery-20261026.asc](guzi-assistant-sparkle-production-v1-recovery-20261026.asc) |
| 配套新密码文件 | `signing/guzi-assistant-sparkle-recovery-20261026-passphrase.local.txt`，本机明文、`0600`、不提交 Git |
| 本次公开验证记录 | [macos-signing-recovery-20261026.json](macos-signing-recovery-20261026.json) |
| 原始身份与创建时验证记录 | [macos-signing-identity.json](macos-signing-identity.json) |
| 应用内置公钥 | [../scripts/sparkle-public-key.txt](../scripts/sparkle-public-key.txt) |
| 私钥在登录钥匙串中的账户 | `cn.shilong.gooz.sparkle.production.v1` |
| 私有源码仓库的 Actions Secret | `Drangon-Li/Guzi-Assistant` → `SPARKLE_PRIVATE_KEY` |
| 同一仓库的 Actions Variable | `SPARKLE_PUBLIC_KEY` |

正式公钥保持不变：

```text
69F8+2FxXMNiiAahs9zuN3p2TU25h8s9MY/30wY0ijA=
```

**新备份**的 SHA256：

```text
702e5ffdd742628b179a5f6320eb12b0343f83aa8eadc434bfd20e10a0e2a190
```

备份使用 OpenPGP 对称加密（AES256、SHA256 iterated salted S2K）；解密得到 Sparkle 使用的 Base64 编码 32 字节私钥种子。备份密码和签名私钥是两项不同的秘密。

身份 JSON 中的 `remoteBackupUploadedAtKeySetup`、`gitOperationsAtKeySetup` 只记录密钥创建时的状态。新备份的恢复证据以本次公开验证记录为准，不能据此推断文件当前是否已提交或上传。

## 2. 旧备份与旧钥匙串：仅作历史备用

原备份 [guzi-assistant-sparkle-production-v1.asc](guzi-assistant-sparkle-production-v1.asc) 保持不变，其 SHA256 为：

```text
626417a5c18d5915816c4735380ad634fa1977e3f9a31cc03a9e013f2d49f581
```

它只与原解密密码配对，不能使用本次新密码。原密码曾保存在旧 Mac 登录钥匙串的以下应用程序密码条目中：

| 属性 | 原值 |
| --- | --- |
| service | `cn.shilong.gooz.sparkle.recovery` |
| account | `production-v1` |
| label | `Guzi Assistant Sparkle recovery passphrase (production v1)` |

仅在需要使用旧备份时，在创建密钥的 macOS 用户下打开“钥匙串访问 / Keychain Access”，搜索上述条目，并通过系统授权查看原密码。macOS 的“密码”App 是另一个应用。[Apple 官方查看步骤](https://support.apple.com/guide/keychain-access/view-the-information-stored-in-a-keychain-kyca1085/mac)

不要用“重置默认钥匙串”尝试找回密码，也不要用新密码覆盖这个旧条目。签名私钥条目通常显示为 `Private key for signing Sparkle updates`，账户为 `cn.shilong.gooz.sparkle.production.v1`；它不是备份解密密码。保留旧备份和原密码信息只是历史备用，新 Mac 的首选恢复流程见下文。

## 3. 在新 Mac 准备文件与工具

以下命令均从私有源码仓库根目录运行。从源码仓库取得可信源码、新 `.asc` 和本次公开验证记录，并按第 1 节核对哈希。

**密码文件必须单独安全复制到新 Mac，Git 克隆不会携带 `.local.*` 文件。** 使用独立密码管理器或离线加密介质保留另一份可取回的副本，并明确标注配套的新 `.asc` 文件名。复制后限制权限并检查忽略规则；若使用旧版克隆或忽略规则被移除，可加入该克隆的 `.git/info/exclude`：

```sh
chmod 600 signing/guzi-assistant-sparkle-recovery-20261026-passphrase.local.txt
if ! git check-ignore -q -- signing/guzi-assistant-sparkle-recovery-20261026-passphrase.local.txt; then
  printf '%s\n' '/signing/*.local.*' >> .git/info/exclude
fi
git check-ignore -- signing/guzi-assistant-sparkle-recovery-20261026-passphrase.local.txt
```

准备 Command Line Tools（尚未安装时执行 `xcode-select --install`）、Node.js ≥22.18、npm 和 GnuPG；使用 Homebrew 的机器可执行 `brew install gnupg`。项目 Mac 构建目标为 Apple Silicon / arm64、macOS 12 及以上，工具还需满足各自系统要求。只有确实需要重建 GitHub Secret 时才需要 GitHub CLI，并先执行 `gh auth login`。

```sh
npm ci
npm run prepare:mac
```

`prepare:mac` 使用 [../scripts/sparkle-release.json](../scripts/sparkle-release.json) 固定的官方 Sparkle 包及 SHA256，准备 `build/sparkle/bin/generate_keys` 和 `sign_update`；本说明核对的版本为 Sparkle 2.10.1。若缺少 Node-API headers，按错误信息设置 `NODE_INCLUDE_DIR` 后重新准备。

先在新 Mac 的“钥匙串访问”检查账户 `cn.shilong.gooz.sparkle.production.v1` 是否已经存在。若存在，只查询公钥：

```sh
build/sparkle/bin/generate_keys --account cn.shilong.gooz.sparkle.production.v1 -p
```

若公钥与第 1 节一致，私钥已迁移，无需重复导入；仍需保管新备份与新密码。如果不同或钥匙串访问失败，停止检查，不要删除、覆盖现有项或生成新密钥。

## 4. 用新备份解密、导入并验证

以下代码用于**该账户尚未存在**的新 Mac。先完成第 3 节，再把整个代码块作为一组执行。密码通过文件描述符 3 传给 GPG，不显示口令，也不依赖旧钥匙串。不要开启 `set -x` 或终端录制。

脚本核对新备份哈希，在仅当前用户可访问的临时目录中解密，导入同一账户，核对公钥，并完成签名/验签和篡改拒绝检查；退出时清理本次临时明文与专用 GPG 环境。换电脑不需要重建现有 Actions Secret；仅在确实需要时，先登录 GitHub CLI，再取消可选上传命令的注释。

```sh
(
  set -eu
  umask 077

  guzi_passphrase_file='signing/guzi-assistant-sparkle-recovery-20261026-passphrase.local.txt'
  if [ ! -f "$guzi_passphrase_file" ] || [ -L "$guzi_passphrase_file" ] || \
     [ "$(stat -f '%Lp' "$guzi_passphrase_file")" != '600' ]; then
    printf '%s\n' '密码文件必须是权限为 0600 的普通文件，且不能是符号链接。' >&2
    exit 1
  fi
  git check-ignore -q -- "$guzi_passphrase_file"
  printf '%s  %s\n' \
    '702e5ffdd742628b179a5f6320eb12b0343f83aa8eadc434bfd20e10a0e2a190' \
    'signing/guzi-assistant-sparkle-production-v1-recovery-20261026.asc' | shasum -a 256 -c -

  guzi_recovery_dir=$(mktemp -d "${TMPDIR:-/tmp}/guzi-sparkle-recovery.XXXXXX")
  guzi_cleanup() {
    rm -f "$guzi_recovery_dir/private-key" "$guzi_recovery_dir/check.bin"
    gpgconf --homedir "$guzi_recovery_dir/gnupg" --kill gpg-agent >/dev/null 2>&1 || :
    rm -rf "$guzi_recovery_dir/gnupg"
    rmdir "$guzi_recovery_dir"
  }
  trap guzi_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  mkdir "$guzi_recovery_dir/gnupg"

  gpg --no-options --homedir "$guzi_recovery_dir/gnupg" \
    --batch --pinentry-mode loopback --no-symkey-cache --passphrase-fd 3 \
    --output "$guzi_recovery_dir/private-key" \
    --decrypt signing/guzi-assistant-sparkle-production-v1-recovery-20261026.asc \
    3< signing/guzi-assistant-sparkle-recovery-20261026-passphrase.local.txt

  build/sparkle/bin/generate_keys \
    --account cn.shilong.gooz.sparkle.production.v1 \
    -f "$guzi_recovery_dir/private-key"

  guzi_expected_public='69F8+2FxXMNiiAahs9zuN3p2TU25h8s9MY/30wY0ijA='
  guzi_restored_public=$(build/sparkle/bin/generate_keys \
    --account cn.shilong.gooz.sparkle.production.v1 -p)
  if [ "$guzi_restored_public" != "$guzi_expected_public" ] || \
     [ "$(cat scripts/sparkle-public-key.txt)" != "$guzi_expected_public" ]; then
    printf '%s\n' '公钥不一致，已停止。不要上传 Secret 或发布更新。' >&2
    exit 1
  fi

  printf '%s\n' 'Guzi Assistant production signing recovery check' \
    > "$guzi_recovery_dir/check.bin"
  guzi_check_signature=$(build/sparkle/bin/sign_update \
    --account cn.shilong.gooz.sparkle.production.v1 \
    -p "$guzi_recovery_dir/check.bin")
  build/sparkle/bin/sign_update \
    --account cn.shilong.gooz.sparkle.production.v1 \
    --verify "$guzi_recovery_dir/check.bin" "$guzi_check_signature"
  printf '%s\n' 'modified' >> "$guzi_recovery_dir/check.bin"
  if build/sparkle/bin/sign_update \
    --account cn.shilong.gooz.sparkle.production.v1 \
    --verify "$guzi_recovery_dir/check.bin" "$guzi_check_signature"; then
    printf '%s\n' '篡改后的文件未被拒绝，已停止。' >&2
    exit 1
  fi

  # 仅在需要重建源码仓库 Secret 时，执行前取消下一行注释。
  # gh secret set SPARKLE_PRIVATE_KEY --repo Drangon-Li/Guzi-Assistant < "$guzi_recovery_dir/private-key"

  printf '%s\n' '本机密钥恢复、公钥核对、签名验签及篡改拒绝通过。临时明文将在退出时删除。'
)
```

若 `generate_keys -f` 报告已有项目或导入失败，停止检查，不要自动删项。必须保留 `--account`，不要无参数运行 `generate_keys` 生成另一套密钥。公钥不一致时，导入可能已写入钥匙串；应先调查，不得继续发布或改写应用公钥。

正常退出、命令失败和可处理的中断会触发清理；断电或强制结束仍可能留下本次 `guzi-sparkle-recovery.*` 目录，应检查并清理其中明文。删除文件不保证 SSD/APFS 上的物理安全擦除。

## 5. 保留恢复能力与恢复 CI

导入签名私钥不会替你备份新密码。继续保管新 `.asc`、配套密码文件及独立密码副本，并清楚标注两者的配对关系。若另存到密码管理器或钥匙串，为本次新备份建立带 `recovery-20261026` 标识的独立条目；**不要用新密码覆盖第 2 节旧条目。** 不要把密码写入 Git、命令参数、终端日志或聊天。

已有 GitHub Actions Secret 不受换机影响，本次恢复也未修改它。若日后确实执行了第 4 节可选命令重建 `SPARKLE_PRIVATE_KEY`：

1. 在[私有源码仓库 Actions 设置](https://github.com/Drangon-Li/Guzi-Assistant/settings/secrets/actions)确认名称及更新时间。GitHub 不提供原值回读，不能把 Secret 当作可下载的备份。
2. 确认 Actions Variable `SPARKLE_PUBLIC_KEY` 与第 1 节及仓库公钥文件一致。它只能保存公开公钥。
3. `RELEASE_REPO_TOKEN` 是跨仓库上传凭据，与签名身份无关，无需因此重建。私钥 Secret 仍只配置在私有源码仓库，不能上传为 Release 附件。
4. 下一次发版先完成现有草稿构建、签名校验和升级测试，再正式发布。上述换机命令不会推送代码或发布版本。

恢复的是 Sparkle 更新签名身份，不是 Apple Developer ID 证书或公证资格。已发布应用仍信任原公钥，不能通过生成另一套密钥处理密码丢失。命令依据为项目固定版本的 `generate_keys --help`、`sign_update --help` 与 `gh secret set --help`；工具准备逻辑见 [../scripts/prepare-sparkle.mjs](../scripts/prepare-sparkle.mjs)。

## 6. 本次 Actions 恢复已完成

本次只为同一 Ed25519 私钥重建了使用新密码的加密备份。原 `SPARKLE_PRIVATE_KEY` Secret、应用公钥及旧 `.asc` 均未修改。

| 证据 | 值或位置 |
| --- | --- |
| 源提交 | `3c6c6fd106891e559f26f3e90aec74d3ef2a4599` |
| 成功的 Actions run | [40275673847](https://github.com/Drangon-Li/Guzi-Assistant/actions/runs/40275673847) |
| 已执行的临时工作流 | [该提交的 recover-sparkle-backup.yml](https://github.com/Drangon-Li/Guzi-Assistant/blob/3c6c6fd106891e559f26f3e90aec74d3ef2a4599/.github/workflows/recover-sparkle-backup.yml) |
| 公开传输请求 | [sparkle-recovery-request-20261026.json](sparkle-recovery-request-20261026.json) |
| 本次公开验证记录 | [macos-signing-recovery-20261026.json](macos-signing-recovery-20261026.json) |
| 本机工具原始报告 | `release/update-verification/signing-recovery-20261026.json` |
| 新 `.asc` | 第 1 节文件，SHA256 为 `702e5ffdd742628b179a5f6320eb12b0343f83aa8eadc434bfd20e10a0e2a190` |

报告中的 `verified: true` 与 `officialSignerVerified: true` 确认：密文封装的签名通过、源提交与 run 匹配；RSA OAEP 解密后的种子对应原正式公钥；新 `.asc` 经 GPG 加密/解密往返一致；Node Ed25519 与官方 Sparkle 工具的签名、验签和篡改拒绝均通过。本地工具在内存中处理私钥种子，未创建私钥种子的明文临时文件。

写入后又在全新的 GPG 环境中，从磁盘上的新 `.asc` 与密码文件独立恢复，所得公钥仍与原正式公钥一致；随机错误密码被拒绝，且解密标准输出没有明文。对应记录为 `postWriteRestoreVerified: true`、`wrongPassphraseRejected: true`。

一次性 RSA 传输私钥 `sparkle-recovery-transfer-20261026.private.local.pem` 已删除，记录为 `transientRecipientKeyRemoved: true`。新密码按用户要求继续保存在本机的 `.local.txt` 文件中，权限 `0600`，且被 Git 忽略；原钥匙串未改动。

临时恢复分支的本地与远端引用均已删除；该工作流没有合入 `main`，历史源提交与执行记录见上表。Actions 密文 artifact 未手动删除，其到期时间为 `2026-10-27T05:42:34Z`（北京时间 2026-10-27 13:42:34）；该附件是传输密文，不是新 Mac 日后恢复所需文件。以后换机只需可信的新 `.asc` 及单独安全复制的配套密码；无需重新运行临时工作流，也无需访问旧 Mac 钥匙串。
