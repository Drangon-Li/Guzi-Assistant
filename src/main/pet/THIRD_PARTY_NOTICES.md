# 第三方代码与资产声明 — 桌宠（pet）

`src/main/pet/` 下的桌宠**运行时逻辑**移植/改编自 **openpets**。

- 项目：openpets — https://github.com/alvinunreal/openpets
- 许可：MIT License（见下）
- 美术：桌宠为本项目自有品牌标（`resources/pet/pet-mark.png`，由 `resources/brand-logo.png` 裁出），不含任何 openpets 资产；原 openpets 雪碧图（"Professor Hoot" 猫头鹰）已移除。
- 未引入：NotoColorEmoji.ttf（OFL 1.1）——本项目不打包，气泡不使用 emoji 字形。

现仅保留自 openpets 的：透明置顶宠物窗口、点击穿透 hit-test、手动拖拽、气泡通知 这套脚手架。动画 / 精灵图渲染 / 运动引擎 / reaction→动画映射 / 显示器 clamp 等均已移除——桌宠是一张静态图标，事件只通过气泡通知。

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
