# 场景识别（Seedance 分镜）

SillyTavern 客户端扩展。**只做一件事**：把聊天里的图送进视觉模型，识别出结构化的「场景内容」文字，再由你手动填入聊天框，让 ST 的角色结合世界书／剧本去写分镜提示词。

## 它不做什么

- ❌ 不代替角色生成提示词（那一步交给 ST 的角色卡与世界书）
- ❌ 不调用你的角色模型，不走 ST 的生成管线
- ❌ 不上传图片到除你配置的视觉模型接口以外的任何地方

## 安装

### 方式 A：交给 SillyTavern 一键安装（推荐，可自动更新）

在 ST 里：**扩展面板（拼图图标）→ Install extension → 粘贴仓库 URL**。

```
https://github.com/mayiajj1-arch/shitu
```

装好后可用面板里的 Update 按钮拉取新版本。

### 方式 B：手动放置

1. 解压本包，得到 `seedance-prompt-builder/` 目录；
2. 整个目录放进：

```
<SillyTavern>/data/default-user/extensions/
```

最终结构应为：

```
data/default-user/extensions/seedance-prompt-builder/
├── index.js
├── manifest.json
├── settings.html
└── style.css
```

3. 刷新 ST 页面（Cmd/Ctrl + Shift + R）。

## 使用

1. 在扩展设置里填 **API Key**（DeepSeek），Base URL 默认 `https://api.deepseek.com`，模型默认 `deepseek-flash`；
   视觉模型必须支持图像输入，`deepseek-v4-pro` 不支持，请勿选它。
2. 聊天里发一张**场景图** → 点「取最后一张图」→「识别画面」。
3. 结果出现在文本框，**可以先编辑**（模型判错的地方直接改）。
4. 需要的话在「填入聊天框时的前缀」写一句（例如：请据此为这场戏写 Seedance 2.5 的图生视频分镜提示词），点「填入聊天框」。
5. 确认草稿后发送，让角色结合世界书剧本产出分镜提示词。

## 识别输出格式

```
【场景主体】【环境与时间】【光线】【画面质感与色调】【构图】
【色与细节】【画面中可动的元素】【画面里不可动或固定的元素】
【画面中缺失但相关内容】
```

最后一行给一条英文运动短语作参考。`【画面中缺失但相关内容】` 用来预警「这一镜需要另配参考图」（图生视频无法让图里没有的主体出现）。

识别提示词可在设置里的「识别提示词（进阶）」自行修改。**注意**：一旦你改过，扩展的协议升级不会再覆盖它。

## 说明

- API Key 存在 ST 的 `settings.json` 里（`extension_settings["seedance-prompt-builder"]`），只发给你配置的接口。
- 适配 SillyTavern 1.12+（使用 `SillyTavern.getContext()`）。
