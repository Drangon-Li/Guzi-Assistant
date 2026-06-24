# 第三方代码与资产声明 — 桌宠（pet）

`src/main/pet/` 下的桌宠运行时移植/改编自 **openpets**，并随附其 spritesheet 资产。

- 项目：openpets — https://github.com/alvinunreal/openpets
- 许可：MIT License（见下）
- 资产：`resources/pet/default-pet-spritesheet.webp` 取自 openpets `apps/desktop/assets/default-pet-spritesheet.webp`，同受其仓库 MIT 覆盖（仓库内无单独署名/第三方授权）。
- 未引入：NotoColorEmoji.ttf（OFL 1.1）——本项目不打包，气泡不使用 emoji 字形。

移植时对其 `app-state` / `i18n` / 插件宿主等做了改写以接入 EShell；运动引擎、显示器 clamp、reaction 映射、气泡仲裁等逻辑保留自 openpets。

---

MIT License

Copyright (c) 2026 OpenPets

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
