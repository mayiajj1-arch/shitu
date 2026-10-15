/**
 * Seedance Prompt Builder — SillyTavern 扩展
 *
 * 分工：
 *   1. 视觉模型（DeepSeek）只负责「识别画面」，输出结构化画面事实；
 *   2. 角色卡（当前角色）负责「写提示词」，在聊天里自然产出。
 *
 * 依据：Seedance 2.5 官方提示词结构 = 主体 + 动作 + 镜头 + 光线 + 风格 (+ 音频)；
 *      图生视频只描述「运动与镜头」，不重复描述图里已有的内容。
 */

// NOTE: 这里刻意不使用静态 import。
// ST 用 <script type="module" src=...> 加载扩展入口；只要该模块图里任何一个
// 依赖请求失败，script.onerror 就会把整个扩展标记为「加载失败: [object Event]」，
// 而那条提示里看不出到底是哪个文件挂了。改成动态 import 后，入口脚本本身一定
// 加载成功，依赖问题会以「具体是哪个 URL 失败」的形式显示在扩展面板里。
let extension_settings, renderExtensionTemplateAsync, saveSettingsDebounced, substituteParams;

// 依赖 URL 一律用 import.meta.url 算成绝对地址。
// 原因：入口脚本的真实 URL 是
//   /scripts/extensions/third-party/<name>/index.js
// 而 ST 的 public 目录布局是 _不齐_ 的：
//   public/scripts/extensions.js      -> /scripts/extensions.js
//   public/script.js                  -> /script.js
//   public/scripts/system-messages.js -> /scripts/system-messages.js
// 手算「../..」层级极易差一级（多退一级会在 /scripts/extensions/ 下找文件而 404，
// 少退一级会在 /scripts/ 下找），且浏览器与 Node 的 URL 归一化行为并不直观。
const DEP_VERSION = '1.1.0';

// ⚠️ 关键：URL 里**绝对不能**带 ?v= 之类的查询串。
// ES 模块的身份是「完整 URL（含查询串）」。ST 的内置扩展都是这样导入的：
//   from '../../extensions.js'          ← 无查询串
// 若我们写成 extensions.js?v=1.0.5，浏览器会认为那是另一个模块，从而把
// extensions.js **执行两遍**。而 extensions.js 里全是模块级状态
// （manifests、activeExtensions、extensionLoadErrors、extension_settings，
//  以及那个 $('html').on('click') 的菜单开关）。两份分裂的状态会直接导致
// 扩展菜单点不开 —— 这就是之前菜单失效的真正原因。
// 相对本模块（/scripts/extensions/third-party/<name>/index.js）的路径：
//   ../          -> /scripts/extensions/third-party/
//   ../../       -> /scripts/extensions/
//   ../../../    -> /scripts/
//   ../../../../ -> /
const DEPS = {
    extensions: new URL('../../../extensions.js', import.meta.url),
    script: new URL('../../../../script.js', import.meta.url),
};
let __depsPromise = null;

/** 把失败 URL 从错误信息里挑出来，方便用户一眼看到是哪个依赖 404。 */
function describeImportError(label, url, error) {
    const reason = error?.message || String(error);
    return `依赖 ${label} 加载失败\n  URL: ${url}\n  原因: ${reason}`;
}

async function ensureDeps() {
    if (!__depsPromise) {
        __depsPromise = (async () => {
            const targets = [
                ['extensions.js', 'extensions', DEPS.extensions],
                ['script.js', 'script', DEPS.script],
            ];
            const settled = await Promise.all(targets.map(async ([label, , url]) => {
                try {
                    return { ok: true, value: await import(url.href) };
                } catch (error) {
                    return { ok: false, message: describeImportError(label, url.href, error) };
                }
            }));

            const failed = settled.filter(r => !r.ok);
            if (failed.length) {
                throw new Error(failed.map(f => f.message).join('\n\n'));
            }

            const [ext, script] = settled.map(r => r.value);
            ({ extension_settings, renderExtensionTemplateAsync } = ext);
            ({ saveSettingsDebounced, substituteParams } = script);

            // 导出缺失检查：静态 import 会直接抛 SyntaxError，动态 import 不会，
            // 所以这里手动补上，避免后续以「undefined is not a function」的模糊形式炸掉。
            const missing = [];
            const require_ = (obj, name, where) => {
                if (obj?.[name] === undefined) missing.push(`${where} 未导出 ${name}`);
            };
            require_(ext, 'extension_settings', 'extensions.js');
            require_(ext, 'renderExtensionTemplateAsync', 'extensions.js');
            require_(script, 'saveSettingsDebounced', 'script.js');
            require_(script, 'substituteParams', 'script.js');
            if (missing.length) {
                throw new Error(`依赖已加载但导出缺失：\n  ${missing.join('\n  ')}`);
            }
        })().catch(error => {
            __depsPromise = null; // 允许下次重试
            throw error;
        });
    }
    return __depsPromise;
}

const MODULE_NAME = 'seedance-prompt-builder';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

const VISION_PROMPT_DEFAULT = `你在为一个「图生视频」的分镜做场景识别。看这张图，只输出画面里实际存在的内容，不要推测剧情、不要编造看不到的东西。

严格按下面的小节输出，用中文，标签原样照写，不要增删小节、不要加粗、不要用 Markdown 代码块：

 【场景主体】
人物或物的具体特征：年龄感、发型发色、服装款式与材质、配色、配件、姿态、朝向、在画面中的位置。多个人物逐个列出。

 【环境与时间】
地点类型、室内外的空间特征、时间与天气、背景中的关键物件。

 【光线】
光源方向、色温、明暗对比、阴影走向、整体氛围。

 【画面质感与色调】
写实摄影／胶片／CG／插画等媒介感、主色调、景深与焦点。

 【构图】
景别、机位角度、主体在画面中的位置、画面前后景的层次关系。

 【色与细节】
主要色相、背景与道具的具体形状与材质、画面里可辨识的具体物件。

 【画面中可动的元素】
逐层列出（前景／主体／中景／背景）：哪些元素能自然运动、各自可能的运动方向与幅度（例如蒸汽上升、液体晃动、发丝轻摆、布料飘动、光线闪烁、火焰跳动）。

 【画面里不可动或固定的元素】
哪些是刚性、固定或不应运动的，避免后续误写。

 【画面中缺失但相关内容】
画面里没有出现、但这个场景可能涉及的重要主体或物件（例如剧本中的其他角色、关键道具、特效元素）。这一项只用于提示「如需这些内容，必须另配参考图」，没有就写「无」。

最后另起一行，输出一行运动提示短语作为参考：英文，一句话，只写运动与镜头（例如 "Slow cinematic drone push forward over a calm lake, gentle water ripples."）。不要重复描述画面里的静帧内容，不要写中文。不要输出镜头或机位的建议——那一步由我自己判断。`;


// 识别协议版本。改动 VISION_PROMPT_DEFAULT 后必须 +1，否则老用户机器上
// settings.json 里已存的旧提示词永远不会被更新（settings() 只在为空时兜底）。
const VISION_PROTOCOL_VERSION = 2;

const DEFAULTS = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    apiKey: '',
    visionPrompt: VISION_PROMPT_DEFAULT,
    visionPromptVersion: VISION_PROTOCOL_VERSION,
    prefix: '',
    targetIndex: null,
};

let busy = false;

/* ------------------------------------------------------------------ 工具 */

function t(key, fallback) {
    try {
        const v = SillyTavern.getContext().translate(key);
        return v && v !== key ? v : fallback;
    } catch {
        return fallback;
    }
}

function setStatus(text, kind = '') {
    const el = document.getElementById('seedance_status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('seedance-error', kind === 'error');
    el.classList.toggle('seedance-ok', kind === 'ok');
}

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULTS };
    }
    const s = extension_settings[MODULE_NAME];
    if (!s.baseUrl) s.baseUrl = DEFAULT_BASE_URL;
    if (!s.model) s.model = DEFAULT_MODEL;
    if (!s.visionPrompt) s.visionPrompt = VISION_PROMPT_DEFAULT;

    // 协议迁移：只在「存的仍是旧内置协议」时替换，用户自己改过的不动。
    // 旧的 230 字协议以「你是视频分镜师」开头且不含小节标记，据此识别。
    const looksLikeLegacy = !String(s.visionPrompt).includes('【')
        && String(s.visionPrompt).startsWith('你是视频分镜师');
    if (Number(s.visionPromptVersion || 0) < VISION_PROTOCOL_VERSION && looksLikeLegacy) {
        console.log('[seedance] 识别协议已升级，替换内置提示词为 v' + VISION_PROTOCOL_VERSION);
        s.visionPrompt = VISION_PROMPT_DEFAULT;
        s.visionPromptVersion = VISION_PROTOCOL_VERSION;
    }
    // 旧版遗留的 instruct 字段已不再使用（角色生成那一步已移除）
    if ('instruct' in s) delete s.instruct;
    if (s.prefix === undefined) s.prefix = '';
    return s;
}

function baseUrl() {
    return String(settings().baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** 找到最近一条带图的消息索引 */
function findLastImageIndex() {
    const chat = SillyTavern.getContext().chat;
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const media = chat[i]?.extra?.media;
        if (Array.isArray(media) && media.length > 0) {
            const usable = media.find(m => m && m.url && String(m.type || '').toUpperCase() !== 'AUDIO');
            if (usable) return i;
        }
    }
    return -1;
}

/** 取出该消息第一张可用图，转成 data URL */
async function grabFirstImageFromMessage(message) {
    const media = Array.isArray(message?.extra?.media) ? message.extra.media : [];
    const attachment = media.find(m => m && m.url && String(m.type || '').toUpperCase() !== 'AUDIO');
    if (!attachment) return null;

    const response = await fetch(attachment.url);
    if (!response.ok) {
        throw new Error(`取图失败 HTTP ${response.status}`);
    }
    const blob = await response.blob();

    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('图片读取失败'));
        reader.readAsDataURL(blob);
    });

    return { dataUrl, url: attachment.url, title: attachment.title || '' };
}

function showPreview(url) {
    const img = document.getElementById('seedance_preview');
    if (!(img instanceof HTMLImageElement)) return;
    if (url) {
        img.src = url;
        img.style.display = '';
    } else {
        img.removeAttribute('src');
        img.style.display = 'none';
    }
}

/* ------------------------------------------------------- 第一步：识别画面 */

async function recognizeImage() {
    if (busy) return;
    const s = settings();

    if (!String(s.apiKey || '').trim()) {
        setStatus(t('请先填入 DeepSeek API Key', '请先在扩展设置里填入 DeepSeek API Key'), 'error');
        return;
    }

    const chat = SillyTavern.getContext().chat;
    const index = Number.isInteger(s.targetIndex) && chat?.[s.targetIndex]?.extra?.media
        ? s.targetIndex
        : findLastImageIndex();

    if (index < 0 || !chat?.[index]) {
        setStatus(t('聊天里没找到图片', '聊天里没找到图片，先发一张再试'), 'error');
        return;
    }

    busy = true;
    setStatus('识别中…');
    try {
        const image = await grabFirstImageFromMessage(chat[index]);
        if (!image) throw new Error('这条消息里没有可用图片');

        showPreview(image.url);

        // deepseek-flash 是推理模型：推理 token 与正文共用 max_tokens。
        // 给太少会出现「reasoning 吃满、正文为空」——所以起步就给足，空了再翻倍重试一次。
        const callModel = async (maxTokens) => {
            const response = await fetch(`${baseUrl()}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${String(s.apiKey).trim()}`,
                },
                body: JSON.stringify({
                    model: s.model || DEFAULT_MODEL,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: substituteParams(s.visionPrompt || VISION_PROMPT_DEFAULT) },
                            { type: 'image_url', image_url: { url: image.dataUrl } },
                        ],
                    }],
                    max_tokens: maxTokens,
                }),
            });

            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
            }
            return response.json();
        };

        let data = await callModel(4000);
        let text = String(data?.choices?.[0]?.message?.content || '').trim();

        if (!text) {
            const finish = data?.choices?.[0]?.finish_reason;
            const reasoning = data?.usage?.completion_tokens_details?.reasoning_tokens;
            console.warn('[seedance] 正文为空，重试', { finish, reasoning });
            if (finish === 'length' || reasoning) {
                data = await callModel(8000);
                text = String(data?.choices?.[0]?.message?.content || '').trim();
            }
        }

        if (!text) throw new Error('模型返回了空内容（该模型可能不支持图像输入，或推理占满了输出额度）');
        const box = document.getElementById('seedance_result');
        if (box instanceof HTMLTextAreaElement) box.value = text;

        setStatus(`识别完成（第 ${index + 1} 条消息）`, 'ok');
    } catch (error) {
        console.error('[seedance] 识别失败', error);
        setStatus(`识别失败：${error?.message || error}`, 'error');
    } finally {
        busy = false;
    }
}

/* ---------------------------------------------------------------- 设置界面 */

function bindInput(id, key, { number = false, after = null } = {}) {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
    el.value = settings()[key] ?? '';
    el.addEventListener('input', () => {
        const raw = el.value;
        settings()[key] = number ? (raw === '' ? null : Number(raw)) : raw;
        saveSettingsDebounced();
        if (typeof after === 'function') after();
    });
}

/** 把识别结果填入 ST 的聊天输入框（不发送，只做草稿，你可以先编辑） */
function injectToChatInput() {
    const box = document.getElementById('seedance_result');
    const text = String(box?.value || '').trim();
    if (!text) {
        setStatus('还没有识别结果，先点「识别画面」', 'error');
        return;
    }
    const prefix = String(settings().prefix || '').trim();
    const payload = prefix ? `${prefix}\n\n${text}` : text;

    // 优先用 ST 自己的上下文 API，退回直接操作输入框
    let ok = false;
    try {
        const context = SillyTavern.getContext();
        if (typeof context?.setTextareaText === 'function') {
            context.setTextareaText(payload);
            const el = document.getElementById('send_textarea');
            if (el) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.focus();
            }
            ok = true;
        }
    } catch (error) {
        console.warn('[seedance] 通过 API 填入失败，改用直接写入', error);
    }

    if (!ok) {
        const el = document.getElementById('send_textarea');
        if (!el) {
            setStatus('找不到聊天输入框，请手动复制下方结果', 'error');
            return;
        }
        el.value = payload;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof el.focus === 'function') el.focus();
    }

    setStatus('已填入聊天框，确认后直接发送', 'ok');
}

async function addSettingsPanel() {
    if (document.getElementById('seedance_grab')) return; // 防重复加载

    const html = await renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'settings');
    $('#extensions_settings2').append(html);

    bindInput('seedance_base_url', 'baseUrl');
    bindInput('seedance_model', 'model');
    bindInput('seedance_api_key', 'apiKey');
    bindInput('seedance_vision_prompt', 'visionPrompt');
    bindInput('seedance_prefix', 'prefix');

    $('#seedance_grab').on('click', () => {
        const index = findLastImageIndex();
        if (index < 0) {
            settings().targetIndex = null;
            showPreview(null);
            setStatus('聊天里没找到图片', 'error');
            return;
        }
        settings().targetIndex = index;
        saveSettingsDebounced();
        showPreview(SillyTavern.getContext().chat[index]?.extra?.media?.[0]?.url || null);
        setStatus(`已选中第 ${index + 1} 条消息的图`, 'ok');
    });

    $('#seedance_recognize').on('click', () => void recognizeImage());
    $('#seedance_inject').on('click', () => injectToChatInput());
}

/* ---------------------------------------------------------------- 入口 */

/**
 * 对外暴露的初始化入口。
 * 注意：manifest.json 里声明了 hooks.activate = "init"，
 * ST 会重新 import 本模块并调用 module.init —— 所以必须导出这个名字。
 */
/** 幂等守卫：无论 ST 调用多少次 activate，只真正初始化一次。 */
let __initialized = false;

export async function init() {
    if (__initialized) {
        console.debug('[seedance] 已初始化，跳过重复调用');
        return;
    }
    __initialized = true;

    try {
        await ensureDeps();
    } catch (error) {
        // 依赖拿不到：面板仍要出现，错误也要看得见，但不向 ST 抛异常。
        console.error('[seedance] 依赖加载失败', error);
        setStatus(`初始化失败：${error?.message || error}`, 'error');
        try { renderFallbackPanel(error); } catch { /* ignore */ }
        return;
    }

    const s = settings();
    // 迁移会改动内存中的设置，落盘保存，避免下次加载又回到旧协议
    if (Number(s.visionPromptVersion || 0) !== VISION_PROTOCOL_VERSION || 'instruct' in s) {
        try { saveSettingsDebounced(); } catch { /* ignore */ }
    }

    // 下面三步互相独立，任一步失败都不应影响其余步骤，也不应影响 ST 自身。
    // 用 Promise.resolve().then 包一层，这样同步抛错和异步拒绝都能被接住。
    const step = (name, fn) => Promise.resolve()
        .then(fn)
        .catch(error => {
            console.warn(`[seedance] ${name} 失败（不影响其他功能）`, error);
            return null;
        });

    await step('渲染设置面板', () => addSettingsPanel());
    await step('挂载图片监听', () => watchMessageImages());

    console.log(`[seedance] Seedance Prompt Builder v${DEP_VERSION} 已加载`);
}

/** 监听新出现的图片按钮：点击即把该消息的图设为识别目标 */
/**
 * 监听聊天里的图片点击 —— 用「事件委托」，不再用 MutationObserver。
 *
 * 为什么改：早先的实现在 #chat 上挂 MutationObserver 监听整棵子树，
 * 并对每个新增节点做 querySelectorAll('.mes_img')，然后给每个图片按钮单独绑定
 * click。这有两个致命问题，只在聊天里有大量图片时才爆发：
 *   1) 同一节点被反复加回（ST 流式输出、重渲染、swipe 都会改动聊天 DOM）时，
 *      监听器会在同一个按钮上重复累积，点一次触发几十个处理器；
 *   2) 大聊天（实测 1.6MB、数百条消息、每条带图）渲染时，观察器对每个新增子树
 *      做全量扫描，主线程被拖死 —— 表现就是「点菜单没反应」。
 * 事件委托只挂 1 个监听器，天然不会重复累积，也不扫描 DOM。
 */
function watchMessageImages() {
    const chat = document.getElementById('chat');
    if (!chat) return;

    // 先解除旧监听，避免 (极少数) 重复初始化时叠加
    if (typeof chat.__seedanceClickHandler === 'function') {
        chat.removeEventListener('click', chat.__seedanceClickHandler);
    }

    const handler = (event) => {
        const button = event.target?.closest?.('.mes_img');
        if (!button || !chat.contains(button)) return;
        const holder = button.closest('.mes');
        if (!holder) return;
        const index = Number(holder.getAttribute('mesid'));
        if (!Number.isInteger(index)) return;
        settings().targetIndex = index;
        saveSettingsDebounced();
        showPreview(button.getAttribute('src') || null);
        setStatus(`已选中第 ${index + 1} 条消息的图`, 'ok');
    };

    chat.addEventListener('click', handler);
    chat.__seedanceClickHandler = handler;
    window.__seedanceChatEl = chat;
}


/** 模板渲染失败时的兜底界面 */
function renderFallbackPanel(error) {
    if (document.getElementById('seedance_grab')) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.className = 'seedance-settings';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>Seedance Prompt Builder</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <div class="seedance-hint">模板渲染失败，已启用兜底界面：${String(error?.message || error)}</div>
                <input id="seedance_base_url" class="text_pole" placeholder="https://api.deepseek.com" />
                <input id="seedance_model" class="text_pole" placeholder="deepseek-flash" />
                <input id="seedance_api_key" class="text_pole" type="password" placeholder="sk-..." />
                <div class="seedance-row">
                    <button id="seedance_grab" class="menu_button">取最后一张图</button>
                    <button id="seedance_recognize" class="menu_button">识别画面</button>
                    <button id="seedance_inject" class="menu_button">填入聊天框</button>
                </div>
                <div id="seedance_status"></div>
                <textarea id="seedance_result" placeholder="识别结果"></textarea>
            </div>
        </div>`;
    host.append(wrap);
    bindInput('seedance_base_url', 'baseUrl');
    bindInput('seedance_model', 'model');
    bindInput('seedance_api_key', 'apiKey');
    $('#seedance_grab').on('click', () => {
        const index = findLastImageIndex();
        if (index < 0) { showPreview(null); setStatus('聊天里没找到图片', 'error'); return; }
        settings().targetIndex = index;
        saveSettingsDebounced();
        setStatus(`已选中第 ${index + 1} 条消息的图`, 'ok');
    });
    $('#seedance_recognize').on('click', () => void recognizeImage());
    $('#seedance_inject').on('click', () => injectToChatInput());
}

export function activate() {
    return init();
}

function onCleanup() {
    try {
        const chat = window.__seedanceChatEl;
        if (chat && typeof chat.__seedanceClickHandler === 'function') {
            chat.removeEventListener('click', chat.__seedanceClickHandler);
            delete chat.__seedanceClickHandler;
        }
        delete window.__seedanceChatEl;
        // 兼容：清理可能由旧版本留下的观察器
        window.__seedanceObserver?.disconnect();
        delete window.__seedanceObserver;
    } catch { /* ignore */ }
    $('#seedance_grab').off('click');
    $('#seedance_recognize').off('click');
    $('#seedance_inject').off('click');
}

export function cleanup() {
    onCleanup();
}

// 初始化只走 ST 的 activate 钩子这一条路径。
//
// 早先这里还有一段「模块加载后自行 init 一次」的兜底，用来防 manifest 钩子没跑到。
// 但那样会产生两条初始化路径：模块加载时一次、ST 调用 activate 钩子时又一次。
// 后果是模板被重复 fetch（实测出现过 net::ERR_ABORTED）、MutationObserver 被挂两次、
// 斜杠命令被注册两次——这类重复副作用正是「面板闪一下」症状的典型来源。
// 现在 manifest 已确认导出 init，兜底不再需要，保持单一初始化路径。
