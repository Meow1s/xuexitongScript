// ==UserScript==
// @name         学习通自动刷课 + 刷题助手 V4
// @namespace    local.codex.xuexitong
// @version      4.3.1
// @description  自动播放、跨章切换小节，自动跳过已完成/零待完成任务点，章节测验与视频弹题自动作答并重试
// @author       Meow1s, Codex
// @homepageURL  https://github.com/Meow1s/xuexitongScript
// @supportURL   https://github.com/Meow1s/xuexitongScript/issues
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      *
// ==/UserScript==

// 本脚本基于 chaolucky18/xuexitongScript 的 V3 版本扩展：
// https://github.com/chaolucky18/xuexitongScript
// 感谢原作者 chaolucky18 及项目所有贡献者。

(function () {
    'use strict';

    // 业务脚本运行在沙箱里，页面全局对象必须通过 unsafeWindow 访问。
    const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const APP_KEY = '__xuexitongAssistantV4';
    const BOOT_TIMER_KEY = '__xuexitongAssistantV4BootTimer';
    const PANEL_HOST_ID = 'xxt-assistant-v4-panel';
    const LEGACY_APP_KEYS = ['__xuexitongPlayerV3', '__xuexitongConsoleDeepSeek', '__xuexitongPlayerV4DeepSeek'];
    const $ = (...args) => PAGE.jQuery.apply(PAGE, args);

    const STORE = {
        settings: 'xxt_v4_settings',
        apiKey: 'xxt_v4_api_key',
        bank: 'xxt_v4_quiz_bank',
    };

    const DEFAULT_SETTINGS = Object.freeze({
        // 播放
        playbackRate: 1.5,
        autoplay: true,
        muteVideo: false,
        autoAdvanceNoVideo: false,
        // 答题
        autoAnswerQuiz: true,
        autoAnswerVideoQuiz: true,
        videoQuizMaxAttempts: 3,
        autoSubmit: true,
        useBank: true,
        apiBase: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        maxQuizQuestions: 50,
        // 等待与轮询（毫秒 / 次数）
        quizPollMs: 500,
        quizWaitTimeoutMs: 120000,
        quizStableChecks: 3,
        submitWaitTimeoutMs: 300000,
        stepWaitTimeoutMs: 120000,
        // 面板
        panelCollapsed: false,
    });

    let settings = loadSettings();
    let apiKey = storageGetText(STORE.apiKey, '') || '';

    // ============================================================
    // 基础工具
    // ============================================================

    function storageGetText(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') {
                const value = GM_getValue(key);
                if (value === undefined || value === null) return fallback;
                return String(value);
            }
            const value = PAGE.localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function storageSetText(key, value) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, String(value));
                return true;
            }
            PAGE.localStorage.setItem(key, String(value));
            return true;
        } catch (error) {
            console.error('保存本地配置失败:', error);
            return false;
        }
    }

    function storageGetJSON(key, fallback) {
        const raw = storageGetText(key, null);
        if (!raw) return fallback;
        try {
            return JSON.parse(raw);
        } catch (error) {
            return fallback;
        }
    }

    function storageSetJSON(key, value) {
        return storageSetText(key, JSON.stringify(value));
    }

    function loadSettings() {
        const saved = storageGetJSON(STORE.settings, {});
        const merged = Object.assign({}, DEFAULT_SETTINGS);
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            for (const key of Object.keys(DEFAULT_SETTINGS)) {
                if (saved[key] !== undefined && typeof saved[key] === typeof DEFAULT_SETTINGS[key]) {
                    merged[key] = saved[key];
                }
            }
        }
        return merged;
    }

    function saveSettings() {
        storageSetJSON(STORE.settings, settings);
    }

    function applySettings(app) {
        if (!app) return;
        app.configs.playbackRate = clampNumber(settings.playbackRate, 1, 16, DEFAULT_SETTINGS.playbackRate);
        app.configs.autoplay = Boolean(settings.autoplay);
        app.configs.muteVideo = Boolean(settings.muteVideo);
        app.configs.autoAdvanceNoVideo = Boolean(settings.autoAdvanceNoVideo);
    }

    function clampNumber(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, number));
    }

    const clean = (value) => String(value === null || value === undefined ? '' : value)
        .replace(/[\s\u3000]+/g, ' ')
        .trim();

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

    let layoutSupport = null;
    function hasLayout() {
        if (layoutSupport === null) {
            try {
                layoutSupport = PAGE.document.body.getClientRects().length > 0;
            } catch (error) {
                layoutSupport = false;
            }
        }
        return layoutSupport;
    }

    function visible(el) {
        if (!el || !el.isConnected) return false;
        let style = null;
        try {
            style = el.ownerDocument.defaultView.getComputedStyle(el);
        } catch (error) {
            style = null;
        }
        if (style && (style.display === 'none' || style.visibility === 'hidden' || (style.opacity ? Number(style.opacity) === 0 : false))) {
            return false;
        }
        try {
            if (el.getClientRects().length > 0) return true;
        } catch (error) {
            // 忽略
        }
        // 无布局环境（测试）拿不到矩形，退化为样式判断。
        return !hasLayout();
    }

    function textOf(el) {
        if (!el) return '';
        const inner = (typeof el.innerText === 'string' && el.innerText) ? el.innerText : '';
        return clean(inner || el.textContent || '');
    }

    function renderedText(el) {
        if (!el) return '';
        return typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
    }

    const BANK_NOISE = /[\s\u3000.,，。;；:：、!！?？"'“”‘’()（）\[\]【】<>《》\-—_…~·]/g;
    const normalizeForBank = (value) => clean(value).replace(BANK_NOISE, '').toLowerCase();

    // ============================================================
    // DeepSeek 接口
    // ============================================================

    const QUIZ_SYSTEM_PROMPT = [
        '你是学习通（超星）网课测验的答题助手。用户会给出整套题目，每道题包含 id、题型（单选题/多选题/判断题）、题干和各选项字母。',
        '请严格按题意作答，遵守以下要求：',
        '1. 题干或选项可能经过网页防复制处理，出现个别汉字被替换、插入无关字或语序异常。先结合上下文与选项在内部还原最可能的原句，再按还原后的题意判断，不要因为个别字异常就放弃作答。',
        '2. 单选题和判断题必须且只能选 1 个选项；多选题选择所有正确选项，不得重复。',
        '3. 每题都必须给出非空答案，只使用该题给出的选项字母；不确定时选择最可能的答案。',
        '4. 先逐项排除明显错误选项，再在剩余选项中选最符合题意的一项；多选题要逐项核对，避免漏选或多选。',
        '5. 如果输入包含 previousAttempt，说明整套答案已被平台判错：请重新逐题审题，至少修正一题你认为最可能错误的题，确认正确的题可以保留，不要机械照抄整份答案。',
        '6. 输出前复核题型和选项数量，不要输出解析或多余文字，只输出 JSON：{"answers":[{"id":1,"letters":["A"]}]}',
    ].join('\n');

    function resolveChatUrl(base) {
        let value = String(base || '').trim() || DEFAULT_SETTINGS.apiBase;
        value = value.replace(/\/+$/, '');
        if (/\/chat\/completions$/.test(value)) return value;
        return value + '/chat/completions';
    }

    function parseJsonSafe(text) {
        if (!text || typeof text !== 'string') return null;
        const trimmed = text.trim()
            .replace(/^\u0060{3}(?:json)?\s*/i, '')
            .replace(/\s*\u0060{3}$/, '');
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            return null;
        }
    }

    function describeHttpError(status, text) {
        let detail = '';
        try {
            const data = JSON.parse(text);
            const raw = (data && data.error && (data.error.message || data.error)) || (data && data.message) || '';
            detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (error) {
            detail = String(text || '').slice(0, 300);
        }
        let head;
        if (status === 401 || status === 403) head = 'API Key 无效或无权限（HTTP ' + status + '）';
        else if (status === 402) head = 'DeepSeek 账户余额不足（HTTP 402）';
        else if (status === 429) head = '请求过于频繁（HTTP 429）';
        else head = '接口返回 HTTP ' + status;
        return detail ? head + '：' + detail : head;
    }

    function gmRequest(options) {
        return new Promise((resolve, reject) => {
            const headers = Object.assign({}, options.headers || {});
            const timeout = options.timeout || 180000;
            const succeed = (status, responseText) => {
                const code = Number(status || 0);
                if (code >= 200 && code < 300) {
                    resolve({ status: code, responseText: responseText || '' });
                    return;
                }
                const error = new Error(describeHttpError(code, responseText));
                error.status = code;
                error.body = responseText;
                reject(error);
            };
            const fail = (message) => reject(new Error(message));

            try {
                if (typeof GM_xmlhttpRequest === 'function') {
                    GM_xmlhttpRequest({
                        url: options.url,
                        method: options.method || 'GET',
                        headers,
                        data: options.data,
                        timeout,
                        onload: (response) => succeed(response.status, response.responseText),
                        onerror: () => fail('网络请求失败，请检查网络连接或接口地址'),
                        ontimeout: () => fail('请求超时，请检查网络或 API 服务是否可用'),
                    });
                    return;
                }
            } catch (error) {
                // 落到 fetch 兜底
            }

            fetch(options.url, {
                method: options.method || 'GET',
                headers,
                body: options.data,
            }).then((response) => response.text().then((text) => succeed(response.status, text)))
                .catch((error) => fail('网络请求失败：' + error.message + '（建议使用 Tampermonkey/Violentmonkey 以绕过 CORS）'));
        });
    }

    function buildQuizPayload(questions) {
        return questions.map((question, index) => ({
            id: index + 1,
            type: question.kind,
            question: question.title.slice(0, 800),
            options: question.options.map((option) => ({
                letter: option.letter,
                text: option.text.slice(0, 500),
            })),
        }));
    }

    function normalizeAnswers(payload, questions) {
        let list = null;
        if (Array.isArray(payload)) list = payload;
        else if (payload && Array.isArray(payload.answers)) list = payload.answers;
        else if (payload && Array.isArray(payload.data)) list = payload.data;
        if (!list) throw new Error('AI 返回内容不是预期的 JSON 结构');
        if (list.length !== questions.length) {
            throw new Error('AI 返回 ' + list.length + ' 题答案，页面识别到 ' + questions.length + ' 题');
        }

        const byId = new Map();
        for (const item of list) {
            if (!item || typeof item !== 'object') throw new Error('AI 返回的答案格式错误');
            const id = Number(item.id);
            if (!Number.isInteger(id) || id < 1 || id > questions.length) {
                throw new Error('AI 返回了无效题号：' + item.id);
            }
            if (byId.has(id)) throw new Error('AI 对第 ' + id + ' 题重复作答');

            let letters = item.letters;
            if (letters === undefined) letters = item.answer !== undefined ? item.answer : item.options;
            if (typeof letters === 'string') letters = letters.split('');
            if (!Array.isArray(letters)) throw new Error('第 ' + id + ' 题答案格式错误');

            const question = questions[id - 1];
            const picked = [];
            for (const raw of letters) {
                const letter = String(raw).trim().toUpperCase().replace(/[^A-H]/g, '');
                if (!letter) continue;
                if (letter.length !== 1) throw new Error('第 ' + id + ' 题答案包含无效选项：' + raw);
                if (!question.options.some((option) => option.letter === letter)) {
                    throw new Error('第 ' + id + ' 题 AI 返回了页面中不存在的选项：' + letter);
                }
                if (!picked.includes(letter)) picked.push(letter);
            }
            if (!picked.length) throw new Error('第 ' + id + ' 题 AI 未给出答案');
            if (question.kind !== '多选题' && picked.length !== 1) {
                throw new Error('第 ' + id + ' 题是' + question.kind + '，AI 却返回了 ' + picked.length + ' 个选项');
            }
            byId.set(id, picked);
        }

        return questions.map((question, index) => {
            const id = index + 1;
            if (!byId.has(id)) throw new Error('AI 漏答了第 ' + id + ' 题');
            return { id, letters: byId.get(id) };
        });
    }

    async function requestAnswers(questions, options = {}) {
        if (!apiKey) throw new Error('尚未配置 DeepSeek API Key，请在右下角面板填写后保存；本次未提交任何答案');

        const url = resolveChatUrl(settings.apiBase);
        const payload = buildQuizPayload(questions);
        const requestPayload = { questions: payload };
        if (options.previousAnswers) {
            const previous = [];
            questions.forEach((question, index) => {
                const id = index + 1;
                const entry = typeof options.previousAnswers.get === 'function'
                    ? options.previousAnswers.get(id)
                    : options.previousAnswers[id];
                if (!entry || !Array.isArray(entry.letters) || !entry.letters.length) return;
                previous.push({
                    id,
                    letters: entry.letters,
                    selected: entry.letters
                        .map((letter) => question.options.find((option) => option.letter === letter))
                        .filter(Boolean)
                        .map((option) => option.text),
                });
            });
            if (previous.length) {
                requestPayload.previousAttempt = {
                    feedback: options.feedback || '平台判定整套答案回答错误',
                    answers: previous,
                };
                requestPayload.retryInstruction = '上一次提交被平台判错，至少有一题错误。请逐题复核，确认正确的题可以保留，重点修改你没有把握的题；不要整份照抄上次答案。';
            }
        }
        console.log('发送给 DeepSeek 的题目：', requestPayload);

        let problem = '';
        for (let attempt = 0; attempt < 3; attempt++) {
            const body = {
                model: settings.model || DEFAULT_SETTINGS.model,
                stream: false,
                temperature: 0.1,
                max_tokens: 8000,
                messages: [
                    { role: 'system', content: QUIZ_SYSTEM_PROMPT },
                    { role: 'user', content: JSON.stringify(requestPayload) },
                ],
            };
            if (attempt === 0) body.response_format = { type: 'json_object' };

            let response;
            try {
                response = await gmRequest({
                    url,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer ' + apiKey,
                    },
                    data: JSON.stringify(body),
                    timeout: 180000,
                });
            } catch (error) {
                if (error.status === 400 && attempt === 0) {
                    // 少数兼容接口不支持 response_format，去掉后重试。
                    problem = error.message;
                    continue;
                }
                throw error;
            }

            const data = parseJsonSafe(response.responseText);
            if (!data) {
                problem = 'AI 接口返回内容无法解析';
                continue;
            }
            if (data.error) {
                const raw = data.error.message || data.error;
                throw new Error(typeof raw === 'string' ? raw : JSON.stringify(raw));
            }
            const choice = data.choices && data.choices[0];
            if (!choice) {
                problem = 'AI 接口没有返回答案';
                continue;
            }
            if (choice.finish_reason === 'length') {
                problem = 'AI 输出达到长度上限，答案可能不完整';
                continue;
            }
            if (choice.finish_reason && choice.finish_reason !== 'stop') {
                problem = 'AI 未正常结束（finish_reason=' + choice.finish_reason + '）';
                continue;
            }

            let content = choice.message && choice.message.content;
            if (Array.isArray(content)) content = content.map((part) => part && part.text || '').join('');
            const parsed = parseJsonSafe(content || '');
            if (!parsed) {
                problem = 'AI 返回空内容或不是合法 JSON';
                continue;
            }
            try {
                return normalizeAnswers(parsed, questions);
            } catch (error) {
                problem = error.message;
            }
        }

        throw new Error((problem || 'AI 作答失败') + '；未提交任何答案');
    }

    // ============================================================
    // 本地题库（按题干文本缓存，选项乱序也能映射）
    // ============================================================

    let bankCount = 0;

    function loadBank() {
        const data = storageGetJSON(STORE.bank, {});
        if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
        bankCount = Object.keys(data).length;
        return data;
    }

    function saveBank(bank) {
        const keys = Object.keys(bank);
        if (keys.length > 3000) {
            keys.sort((a, b) => (bank[b].ts || 0) - (bank[a].ts || 0));
            for (const key of keys.slice(3000)) delete bank[key];
        }
        bankCount = Object.keys(bank).length;
        storageSetJSON(STORE.bank, bank);
    }

    function bankKey(question) {
        return question.kind + '::' + normalizeForBank(question.title);
    }

    function bankLetters(entry, question) {
        if (!entry || !Array.isArray(entry.a) || !entry.a.length) return null;
        const letters = [];
        for (const text of entry.a) {
            const target = normalizeForBank(text);
            const option = question.options.find((item) => normalizeForBank(item.text) === target);
            if (!option) return null;
            if (!letters.includes(option.letter)) letters.push(option.letter);
        }
        if (!letters.length) return null;
        if (question.kind !== '多选题' && letters.length !== 1) return null;
        return letters;
    }

    function rememberAnswer(bank, question, letters) {
        const texts = letters
            .map((letter) => question.options.find((option) => option.letter === letter))
            .filter(Boolean)
            .map((option) => option.text);
        if (!texts.length) return;
        bank[bankKey(question)] = { t: question.kind, a: texts, ts: Date.now() };
    }

    // 视频弹题只有确认答对后才写题库，答错则删掉本轮题目，避免错答案被下次直接命中。
    function saveAnswersToBank(questions, answers) {
        if (!settings.useBank) return;
        const bank = loadBank();
        questions.forEach((question, index) => {
            const entry = answers.get(index + 1);
            if (entry && Array.isArray(entry.letters) && entry.letters.length) {
                rememberAnswer(bank, question, entry.letters);
            }
        });
        saveBank(bank);
    }

    function forgetAnswersFromBank(questions) {
        if (!settings.useBank) return;
        const bank = loadBank();
        let changed = false;
        for (const question of questions) {
            const key = bankKey(question);
            if (Object.prototype.hasOwnProperty.call(bank, key)) {
                delete bank[key];
                changed = true;
            }
        }
        if (changed) saveBank(bank);
    }

    async function resolveAnswers(questions, options = {}) {
        const saveToBank = options.saveToBank !== false;
        const bank = settings.useBank ? loadBank() : {};
        const result = new Map();
        const missing = [];

        questions.forEach((question, index) => {
            const id = index + 1;
            const letters = settings.useBank ? bankLetters(bank[bankKey(question)], question) : null;
            if (letters) {
                result.set(id, { letters, source: '题库' });
                return;
            }
            missing.push({ id, question });
        });

        if (missing.length) {
            console.log('题库未命中的题目：', missing.map((item) => item.id));
            const answers = await requestAnswers(missing.map((item) => item.question), options.requestOptions || {});
            const freshBank = settings.useBank ? loadBank() : {};
            answers.forEach((answer, index) => {
                const entry = missing[index];
                result.set(entry.id, { letters: answer.letters, source: 'AI' });
                if (settings.useBank && saveToBank) rememberAnswer(freshBank, entry.question, answer.letters);
            });
            if (settings.useBank && saveToBank) saveBank(freshBank);
        }

        return result;
    }

    // ============================================================
    // 章节测验 DOM 识别
    // ============================================================

    const kindPattern = /[\[【（(]\s*(单选题|多选题|判断题)\s*[\]】）)]/;

    function courseDocuments() {
        const result = [];
        const visit = (doc, depth) => {
            if (!doc || depth > 3 || result.includes(doc)) return;
            result.push(doc);
            let frames = [];
            try {
                frames = doc.querySelectorAll('iframe');
            } catch (error) {
                return;
            }
            for (const frame of frames) {
                let frameDocument = null;
                try {
                    frameDocument = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
                } catch (error) {
                    frameDocument = null;
                }
                if (frameDocument) visit(frameDocument, depth + 1);
            }
        };
        visit(PAGE.document, 0);
        return result;
    }

    function optionElements(card) {
        const selector = 'span,div,label,li,p,b,i,strong,a';
        let labels = [];
        try {
            labels = Array.from(card.querySelectorAll(selector)).filter((el) =>
                /^[A-H]$/.test(textOf(el)) &&
                !Array.from(el.children).some((child) => /^[A-H]$/.test(textOf(child)))
            );
        } catch (error) {
            return [];
        }

        const found = new Map();
        for (const label of labels) {
            const letter = textOf(label);
            if (found.has(letter)) continue;
            let target = label;
            for (let depth = 0; depth < 5; depth++) {
                const parent = target.parentElement;
                if (!parent || parent === card) break;
                const otherLetters = Array.from(parent.querySelectorAll(selector))
                    .filter((el) => /^[A-H]$/.test(textOf(el)) && el !== label);
                if (otherLetters.some((el) => !el.contains(label) && !label.contains(el))) break;
                target = parent;
                if (textOf(target).length > 1) break;
            }
            const text = textOf(target).replace(new RegExp('^' + letter + '[.、．:：]?\\s*'), '');
            if (text) found.set(letter, { letter, text, element: target });
        }
        return Array.from(found.values()).sort((a, b) => a.letter.localeCompare(b.letter));
    }

    function textBeforeElement(root, stopElement) {
        if (!root) return '';
        let output = '';
        try {
            const doc = root.ownerDocument;
            const treeWalker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = treeWalker.nextNode())) {
                if (stopElement && stopElement.contains(node)) break;
                output += ' ' + node.nodeValue;
            }
        } catch (error) {
            return '';
        }
        return clean(output);
    }

    function buildQuestionTitle(card, firstOption, fallback) {
        let text = textBeforeElement(card, firstOption);
        if (!text) text = textOf(fallback);
        if (!text) text = textOf(card);
        return clean(
            text
                .replace(/^\s*\d+\s*[.、．]\s*/, '')
                .replace(kindPattern, '')
                .replace(/[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]/g, '')
        ).slice(0, 800);
    }

    function extractQuestions() {
        const questions = [];
        for (const doc of courseDocuments()) {
            if (!doc.body) continue;
            let treeWalker;
            try {
                treeWalker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
            } catch (error) {
                continue;
            }
            const seenCards = new Set();
            let node;
            while ((node = treeWalker.nextNode())) {
                const matched = clean(node.nodeValue).match(kindPattern);
                if (!matched || !visible(node.parentElement)) continue;
                const kind = matched[1];
                let card = node.parentElement;
                let options = [];
                for (let depth = 0; card && depth < 9; depth++, card = card.parentElement) {
                    const kinds = textOf(card).match(/[\[【（(]\s*(单选题|多选题|判断题)\s*[\]】）)]/g) || [];
                    if (kinds.length > 1) break;
                    options = optionElements(card);
                    if (options.length >= 2 && options.length <= 8) break;
                }
                if (!card || options.length < 2 || options.length > 8 || seenCards.has(card)) continue;
                const title = buildQuestionTitle(card, options[0].element, node.parentElement);
                if (!title) continue;
                seenCards.add(card);
                questions.push({ kind, title, options, card, doc });
            }
        }
        return questions;
    }

    function findButton(doc, label) {
        if (!doc) return null;
        let nodes = [];
        try {
            nodes = Array.from(doc.querySelectorAll('button,a,input[type="button"],input[type="submit"],[role="button"],div,span'));
        } catch (error) {
            return null;
        }
        const exact = nodes.filter((el) => visible(el) && clean(el.value || textOf(el)) === label);
        return exact.find((el) => /^(BUTTON|A|INPUT)$/.test(el.tagName)) ||
            exact.find((el) => !Array.from(el.children).some((child) => clean(child.value || textOf(child)) === label)) ||
            null;
    }

    const NEXT_STEP_TEXTS = ['下一节', '下一章', '下一部分', '下一任务点'];

    function findNextButton() {
        for (const doc of courseDocuments()) {
            let known = null;
            try {
                known = doc.querySelector('#prevNextFocusNext, #right1, .nextChapter');
            } catch (error) {
                known = null;
            }
            if (known && visible(known) && NEXT_STEP_TEXTS.some((text) => textOf(known).includes(text))) {
                return known;
            }
            for (const label of NEXT_STEP_TEXTS) {
                const generic = findButton(doc, label);
                if (generic) return generic;
            }
        }
        return null;
    }

    function quizCompleted() {
        const scoreShown = courseDocuments().some((doc) => {
            if (!doc.body) return false;
            const text = clean(renderedText(doc.body));
            return /本次成绩\s*\d+(?:\.\d+)?\s*分/.test(text) &&
                (/章节测验\s*已完成/.test(text) || /我的答案\s*[:：]/.test(text));
        });
        if (scoreShown) return true;

        let cardsFrame = null;
        try {
            cardsFrame = Array.from(PAGE.document.querySelectorAll('iframe[src*="/knowledge/cards"]'))
                .find((frame) => visible(frame));
        } catch (error) {
            cardsFrame = null;
        }
        if (cardsFrame) {
            try {
                const num = new URL(cardsFrame.getAttribute('src'), PAGE.location.href).searchParams.get('num');
                if (num === '1' && PAGE.document.querySelector('.posCatalog_active .icon_Completed')) return true;
            } catch (error) {
                // 忽略
            }
        }
        return false;
    }

    async function revealQuizQuestions() {
        try {
            const submit = courseDocuments().map((doc) => findButton(doc, '提交')).find(Boolean);
            if (!submit) return;
            const doc = submit.ownerDocument;
            let scroller = submit.parentElement;
            while (scroller && scroller !== doc.body) {
                const style = doc.defaultView.getComputedStyle(scroller);
                if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 100) break;
                scroller = scroller.parentElement;
            }
            if (!scroller || scroller === doc.body) scroller = doc.scrollingElement;
            if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 100) return;
            scroller.scrollTop = 0;
            await sleep(150);
            for (let step = 0; step < 80; step++) {
                const bottom = scroller.scrollHeight - scroller.clientHeight;
                if (scroller.scrollTop >= bottom - 2) break;
                scroller.scrollTop = Math.min(bottom, scroller.scrollTop + Math.max(300, scroller.clientHeight * 0.75));
                await sleep(120);
            }
        } catch (error) {
            console.warn('滚动题目区域失败（不影响识别）:', error);
        }
    }

    async function waitForQuizQuestions(isStopped) {
        const pollMs = Math.max(50, clampNumber(settings.quizPollMs, 50, 5000, 500));
        const deadline = Date.now() + Math.max(1000, clampNumber(settings.quizWaitTimeoutMs, 1000, 900000, 120000));

        let submitDoc = null;
        while (Date.now() < deadline) {
            if (isStopped()) throw new Error('脚本已停止');
            if (quizCompleted()) return null;
            submitDoc = courseDocuments().find((doc) => findButton(doc, '提交'));
            if (submitDoc) break;
            await sleep(pollMs);
        }
        if (!submitDoc) {
            throw new Error('等待超时仍未找到“提交”按钮，请检查题目框架是否正常加载');
        }

        await revealQuizQuestions();

        let previousSignature = '';
        let stableCount = 0;
        const requiredStable = Math.max(1, clampNumber(settings.quizStableChecks, 1, 10, 3));
        while (Date.now() < deadline) {
            if (isStopped()) throw new Error('脚本已停止');
            if (quizCompleted()) return null;
            const questions = extractQuestions();
            const countText = clean(renderedText(submitDoc.body)).match(/题量\s*[:：]\s*(\d+)/);
            const expected = countText ? Number(countText[1]) : null;
            if (questions.length && (!expected || questions.length === expected)) {
                const signature = questions
                    .map((question) => question.kind + ':' + normalizeForBank(question.title) + ':' + question.options.length)
                    .join('|');
                stableCount = signature === previousSignature ? stableCount + 1 : 0;
                previousSignature = signature;
                if (stableCount >= requiredStable) return questions;
            } else {
                stableCount = 0;
                previousSignature = '';
            }
            await sleep(pollMs);
        }
        throw new Error('题目框架已打开，但等待超时仍未识别到完整题目；可点击面板“识别题目”查看当前结果');
    }

    async function selectAnswers(questions, answers, isStopped) {
        for (let index = 0; index < questions.length; index++) {
            const question = questions[index];
            const picked = answers.get(index + 1).letters;
            for (const letter of picked) {
                if (isStopped()) throw new Error('脚本已停止');
                const option = question.options.find((item) => item.letter === letter);
                if (!option || !option.element || !option.element.isConnected) {
                    throw new Error('第 ' + (index + 1) + ' 题选项 ' + letter + ' 已失效');
                }
                try {
                    option.element.scrollIntoView({ block: 'center' });
                } catch (error) {
                    // 忽略
                }
                const before = question.card.outerHTML;
                option.element.click();
                await sleep(150);
                const input = option.element.matches('input') ? option.element : option.element.querySelector('input');
                const checked = Boolean(input && input.checked) || option.element.getAttribute('aria-checked') === 'true';
                if (before === question.card.outerHTML && !checked) {
                    throw new Error('第 ' + (index + 1) + ' 题 ' + letter + ' 选项点击后没有选中，已停止提交');
                }
            }
        }
    }

    async function confirmSubmitDialog(isStopped, log) {
        for (let attempt = 0; attempt < 20; attempt++) {
            if (isStopped()) throw new Error('脚本已停止');
            const dialogs = courseDocuments().flatMap((doc) => {
                try {
                    return Array.from(doc.querySelectorAll('#popok,[role="dialog"],[role="alertdialog"],.layui-layer-dialog,.el-message-box,.modal'));
                } catch (error) {
                    return [];
                }
            });

            const platformButton = dialogs.find((el) => el.id === 'popok' && visible(el));
            if (platformButton) {
                const message = textOf(platformButton.ownerDocument.querySelector('#popcontent'));
                if (/未作答|请选择|请作答|答完/.test(message) && !/确定提交|确认提交/.test(message)) {
                    throw new Error('平台拒绝提交：' + message);
                }
                log('确认平台提交窗口：' + (message || '提交'));
                platformButton.click();
                return;
            }

            const dialog = dialogs.find((el) => el.id !== 'popok' && visible(el) && /提交|交卷/.test(textOf(el)));
            if (dialog) {
                const confirm = findButton(dialog, '确定') || findButton(dialog, '确认') || findButton(dialog, '提交');
                if (!confirm) throw new Error('提交确认窗口没有找到确认按钮');
                confirm.click();
                return;
            }
            await sleep(250);
        }
        log('未出现二次确认窗口，继续等待结果页', 'warn');
    }

    async function submitQuiz(questionDoc, isStopped, log) {
        if (isStopped()) throw new Error('脚本已停止');
        const submit = findButton(questionDoc, '提交');
        if (!submit) throw new Error('未找到测验提交按钮');
        try {
            submit.scrollIntoView({ block: 'center' });
        } catch (error) {
            // 忽略
        }
        log('选项已全部选中，点击“提交”');
        submit.click();
        await confirmSubmitDialog(isStopped, log);
        log('提交已确认');
    }

    async function waitForQuizCompleted(isStopped, log) {
        const total = Math.max(5000, clampNumber(settings.submitWaitTimeoutMs, 5000, 1800000, 300000));
        const deadline = Date.now() + total;
        let waited = 0;
        while (!isStopped() && Date.now() < deadline) {
            if (quizCompleted()) return true;
            await sleep(500);
            waited += 500;
            if (waited % 15000 === 0) log('等待成绩页… 已等待 ' + Math.round(waited / 1000) + ' 秒');
        }
        if (isStopped()) throw new Error('脚本已停止');
        throw new Error('已提交，但 ' + Math.round(total / 1000) + ' 秒内没有检测到成绩页或完成标记；请人工确认后手动点击“下一节”');
    }

    // ============================================================
    // 视频内嵌弹题（视频题）DOM 识别
    // ============================================================

    const VIDEO_QUIZ_OPTION_SELECTOR = 'li.ans-videoquiz-opt';

    function firstVisible(doc, selector) {
        if (!doc) return null;
        try {
            return Array.from(doc.querySelectorAll(selector)).find((el) => visible(el)) || null;
        } catch (error) {
            return null;
        }
    }

    function findVideoQuizContainers() {
        const containers = [];
        for (const doc of courseDocuments()) {
            let nodes = [];
            try {
                nodes = Array.from(doc.querySelectorAll('.tkTopic'));
            } catch (error) {
                nodes = [];
            }
            for (const node of nodes) {
                if (visible(node) && !containers.includes(node)) containers.push(node);
            }
        }
        return containers;
    }

    function hasOpenVideoQuiz() {
        return findVideoQuizContainers().length > 0;
    }

    function stripOptionLetter(text) {
        return clean(String(text || '').replace(/^[A-H]\s*[.、．:：)）]\s*/i, ''));
    }

    function videoQuizOptions(item) {
        let nodes = [];
        try {
            nodes = Array.from(item.querySelectorAll(VIDEO_QUIZ_OPTION_SELECTOR));
        } catch (error) {
            nodes = [];
        }
        if (!nodes.length) {
            try {
                nodes = Array.from(item.querySelectorAll('ul.tkItem_ul > li'));
            } catch (error) {
                nodes = [];
            }
        }
        const options = [];
        nodes.forEach((node, index) => {
            const input = node.querySelector('input[type="radio"],input[type="checkbox"]');
            const label = node.querySelector('label') || node;
            let text = stripOptionLetter(textOf(label));
            if (!text) text = stripOptionLetter(textOf(node));
            if (!text) return;
            options.push({
                letter: String.fromCharCode(65 + index),
                text,
                element: node,
                label,
                input,
            });
        });
        return options;
    }

    function videoQuizKind(item, container) {
        const text = textOf(item) + ' ' + textOf(container.querySelector('.tkTopic_title'));
        const matched = text.match(/(单选题|多选题|判断题)/);
        if (matched) return matched[1];
        if (item.querySelector('input[type="checkbox"]')) return '多选题';
        return '单选题';
    }

    function videoQuizTitle(item, firstOption) {
        const titleElement = item.querySelector('.tkItem_title');
        let title = textOf(titleElement);
        if (!title) title = textBeforeElement(item, firstOption);
        return clean(
            title
                .replace(/^\s*\d+\s*[.、．:：]\s*/, '')
                .replace(kindPattern, '')
                .replace(/单选题|多选题|判断题/g, '')
                .replace(/[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]/g, '')
        ).slice(0, 800);
    }

    function extractVideoQuizQuestions(container) {
        if (!container || !container.ownerDocument) return [];
        let items = [];
        try {
            items = Array.from(container.querySelectorAll('.tkItem'));
        } catch (error) {
            items = [];
        }
        if (!items.length) items = [container];

        const questions = [];
        const seen = new Set();
        for (const item of items) {
            const options = videoQuizOptions(item);
            if (options.length < 2 || options.length > 8) continue;
            const title = videoQuizTitle(item, options[0].element);
            if (!title) continue;
            const kind = videoQuizKind(item, container);
            const signature = kind + '::' + normalizeForBank(title);
            if (seen.has(signature)) continue;
            seen.add(signature);
            questions.push({
                kind,
                title,
                options,
                card: container,
                doc: container.ownerDocument,
                item,
            });
        }
        return questions;
    }

    function findVideoQuizQuestions() {
        const questions = [];
        for (const container of findVideoQuizContainers()) {
            questions.push(...extractVideoQuizQuestions(container));
        }
        return questions;
    }

    function findVideoQuizSubmit(container) {
        if (!container || !container.ownerDocument) return null;
        const doc = container.ownerDocument;
        const candidates = [];
        try {
            candidates.push(
                container.querySelector('#videoquiz-submit'),
                container.querySelector('a.ans-videoquiz-submit:not(#videoquiz-submitting)'),
                doc.querySelector('#videoquiz-submit'),
                doc.querySelector('a.ans-videoquiz-submit:not(#videoquiz-submitting)')
            );
            candidates.push(...container.querySelectorAll('.tkTopic_oper button, .tkTopic_oper a'));
        } catch (error) {
            // 忽略
        }
        return candidates.find((el) => {
            if (!el || !visible(el) || el.disabled) return false;
            if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
            const className = typeof el.className === 'string' ? el.className : '';
            if (/(^|\s)disabled(\s|$)/.test(className)) return false;
            const label = textOf(el);
            if (/提交中/.test(label)) return false;
            // .tkTopic_oper 里还有“继续播放/返回重做”，不能把任意操作按钮都当提交按钮。
            return /提交/.test(label) || el.id === 'videoquiz-submit' ||
                className.indexOf('ans-videoquiz-submit') >= 0;
        }) || null;
    }

    function findVideoQuizContinue(container) {
        const doc = container && container.ownerDocument;
        return firstVisible(container, '#videoquiz-continue, a.ans-videoquiz-continue') ||
            firstVisible(doc, '#videoquiz-continue, a.ans-videoquiz-continue');
    }

    function findVideoQuizBack(container) {
        const doc = container && container.ownerDocument;
        return firstVisible(container, '#knowledgeBack, a.ans-videoquiz-back') ||
            firstVisible(doc, '#knowledgeBack, a.ans-videoquiz-back');
    }

    function videoQuizResultState(container) {
        const doc = container && container.ownerDocument;
        if (!doc) return { correct: false, wrong: false };
        const correct = Boolean(firstVisible(container, '.spanHas') || firstVisible(doc, '.spanHas'));
        const wrong = Boolean(firstVisible(container, '.spanNot, .spanNotBack') ||
            firstVisible(doc, '.spanNot, .spanNotBack'));
        // 重试时平台可能保留上一次的正确标记；只要出现错误标记就以错误为准。
        return { correct: correct && !wrong, wrong: wrong };
    }

    function resetVideoQuizResultMarks(container) {
        if (!container || typeof container.querySelectorAll !== 'function') return;
        for (const selector of ['.spanHas', '.spanNot', '.spanNotBack', '#spanNotBackPoint']) {
            let nodes = [];
            try {
                nodes = Array.from(container.querySelectorAll(selector));
            } catch (error) {
                nodes = [];
            }
            for (const node of nodes) node.style.display = 'none';
        }
    }

    function videoQuizOptionChecked(option) {
        if (!option) return false;
        if (option.input && option.input.checked) return true;
        const element = option.element;
        if (!element) return false;
        if (element.getAttribute('aria-checked') === 'true') return true;
        const className = typeof element.className === 'string' ? element.className : '';
        return /(^|\s)(selected|checked|active)(\s|$)/.test(className);
    }

    async function selectVideoQuizAnswers(questions, answers, isStopped) {
        for (let index = 0; index < questions.length; index++) {
            const question = questions[index];
            const picked = answers.get(index + 1).letters;
            for (const letter of picked) {
                if (isStopped()) throw new Error('脚本已停止');
                const option = question.options.find((item) => item.letter === letter);
                if (!option || !option.element || !option.element.isConnected) {
                    throw new Error('视频弹题第 ' + (index + 1) + ' 题选项 ' + letter + ' 已失效');
                }
                if (videoQuizOptionChecked(option)) continue;

                const targets = [];
                if (option.label && option.label !== option.element) targets.push(option.label);
                targets.push(option.element);
                if (option.input) targets.push(option.input);

                let selected = false;
                for (const target of targets) {
                    try {
                        target.scrollIntoView({ block: 'center' });
                    } catch (error) {
                        // 忽略
                    }
                    target.click();
                    await sleep(150);
                    if (videoQuizOptionChecked(option)) {
                        selected = true;
                        break;
                    }
                }
                if (!selected) {
                    throw new Error('视频弹题第 ' + (index + 1) + ' 题 ' + letter + ' 选项点击后没有选中，已停止提交');
                }
            }
        }
    }

    async function clearVideoQuizSelections(questions, isStopped) {
        for (const question of questions) {
            for (const option of question.options) {
                if (isStopped && isStopped()) throw new Error('脚本已停止');
                if (!option.input || option.input.type !== 'checkbox' || !option.input.checked) continue;
                const targets = [];
                if (option.label && option.label !== option.element) targets.push(option.label);
                targets.push(option.element);
                if (option.input) targets.push(option.input);
                for (const target of targets) {
                    try {
                        target.click();
                    } catch (error) {
                        // 忽略
                    }
                    await sleep(80);
                    if (!option.input.checked) break;
                }
            }
        }
    }

    async function waitForVideoQuizSubmitForRetry(container, isStopped, log) {
        const startedAt = Date.now();
        const deadline = startedAt + 20000;
        let backClicked = false;
        while (Date.now() < deadline) {
            if (isStopped && isStopped()) throw new Error('脚本已停止');
            const current = findVideoQuizContainers()[0] ||
                (container && container.isConnected && visible(container) ? container : null);
            if (current) {
                const submit = findVideoQuizSubmit(current);
                if (submit) return { container: current, submit: submit };
                const back = findVideoQuizBack(current);
                if (back && !backClicked) {
                    backClicked = true;
                    if (log) log('视频弹题答错，点击“返回重做”准备重试', 'warn');
                    back.click();
                    await sleep(900);
                    continue;
                }
                // 平台只给“继续播放”时无法原地重做，交给上层停止并提示手动处理。
                if (!backClicked && !back && findVideoQuizContinue(current)) return null;
            } else if (Date.now() - startedAt > 8000) {
                return null;
            }
            await sleep(300);
        }
        return null;
    }

    async function waitForVideoQuizOutcome(container, isStopped, log) {
        const total = Math.max(10000, Math.min(90000, clampNumber(settings.submitWaitTimeoutMs, 5000, 1800000, 300000)));
        const deadline = Date.now() + total;
        while (Date.now() < deadline) {
            if (isStopped()) throw new Error('脚本已停止');
            const continueEl = findVideoQuizContinue(container);
            const state = videoQuizResultState(container);
            if (continueEl) {
                if (!state.correct && !state.wrong) {
                    // “继续播放”可能比对错标记先出现，稍等再读一次状态。
                    await sleep(500);
                    const lateState = videoQuizResultState(container);
                    return { type: 'continue', continueEl, correct: lateState.correct, wrong: lateState.wrong };
                }
                return { type: 'continue', continueEl, correct: state.correct, wrong: state.wrong };
            }
            if (state.correct || state.wrong) {
                await sleep(600);
                const lateContinue = findVideoQuizContinue(container);
                if (lateContinue) return { type: 'continue', continueEl: lateContinue, correct: state.correct, wrong: state.wrong };
                return { type: state.wrong ? 'wrong' : 'result', correct: state.correct, wrong: state.wrong };
            }
            if (!findVideoQuizContainers().length) return { type: 'closed' };
            await sleep(300);
        }
        if (log) log('视频弹题提交后等待结果超时，请手动确认', 'warn');
        return { type: 'timeout' };
    }

    async function resumeVideoAfterQuiz(app, log) {
        await sleep(400);
        let video = null;
        try {
            app._videoEl = null;
            video = app._getVideoEl();
        } catch (error) {
            video = null;
        }
        if (!video) {
            if (log) log('视频弹题已处理，但未找到视频元素，请手动点播放', 'warn');
            return false;
        }
        if (video.ended) {
            // 弹题出现在视频末尾时，平台恢复播放会把视频从头重播；这里直接进入下一节。
            if (log) log('视频已播放完毕，准备切换下一节');
            app._isPlaying = false;
            setTimeout(() => app.nextUnit(), 500);
            return true;
        }
        app._isPlaying = true;
        try {
            // 播放器元素可能在弹题前后被平台替换，重新绑定 play/pause/ended 事件。
            app._videoEventHandle();
        } catch (error) {
            // 忽略
        }
        if (video.paused) {
            try {
                if (app.configs.muteVideo) {
                    video.muted = true;
                    video.defaultMuted = true;
                    video.volume = 0;
                }
                await video.play();
            } catch (error) {
                try {
                    video.muted = true;
                    await video.play();
                } catch (secondError) {
                    if (log) log('视频弹题后恢复播放失败：' + secondError.message, 'warn');
                    return false;
                }
            }
        }
        try {
            app._startVideoMonitoring();
        } catch (error) {
            // 忽略
        }
        return true;
    }

    // ============================================================
    // 把答题模块挂到播放器上
    // ============================================================

    function attachQuizAutomation(app) {
        const attemptedQuizzes = new Set();
        const preparedQuizzes = new Set();
        const attemptedVideoQuizzes = new Set();
        const preparedVideoQuizzes = new Set();
        let quizBusy = false;
        let videoQuizBusy = false;
        let stopped = false;
        let autoPausedForStep = false;
        let videoPausedForStep = false;
        let watchdog = null;
        let lastStepTitle = '';

        const log = (message, level) => {
            try {
                if (app._panel) app._panel.log(message, level || 'info');
            } catch (error) {
                // 面板不可用时忽略
            }
        };
        const isStopped = () => stopped;

        app._quizPhase = 'idle';

        app.inspectQuiz = function () {
            let questions = extractQuestions();
            if (!questions.length) questions = findVideoQuizQuestions();
            return questions.map((question, index) => ({
                id: index + 1,
                type: question.kind,
                question: question.title,
                options: question.options.map((option) => option.letter + '. ' + option.text),
            }));
        };

        app.inspectVideoQuiz = function () {
            return findVideoQuizQuestions().map((question, index) => ({
                id: index + 1,
                type: question.kind,
                question: question.title,
                options: question.options.map((option) => option.letter + '. ' + option.text),
            }));
        };

        app.answerQuiz = function () {
            if (stopped) return Promise.resolve();
            if (app._isChapterTest()) return runQuiz('manual');
            if (hasOpenVideoQuiz()) return runVideoQuiz('manual');
            log('当前不在章节测验或视频弹题页面，未执行答题', 'warn');
            return Promise.resolve();
        };

        app.clearAnswerBank = function () {
            storageSetJSON(STORE.bank, {});
            bankCount = 0;
            log('本地题库已清空', 'ok');
            return true;
        };

        app.getAnswerBank = function () {
            return loadBank();
        };

        function quizSignature(questions) {
            let href = '';
            try {
                href = questions[0].doc.defaultView.location.href;
            } catch (error) {
                href = '';
            }
            return href + '||' + questions
                .map((question) => question.kind + ':' + normalizeForBank(question.title))
                .join('|');
        }

        async function goToNextStep() {
            if (stopped) throw new Error('脚本已停止');
            const next = findNextButton();
            if (!next) throw new Error('未找到页面下方的“下一节/下一章”按钮');

            const previousStep = app._currentStepTitle();
            const previousSignature = app._stepSignature();
            const nextLabel = textOf(next) || '下一节';
            app._nextUnitPending = true;
            app._clearCheckInterval();
            app._videoEl = null;
            app._isPlaying = false;
            try {
                next.scrollIntoView({ block: 'center' });
            } catch (error) {
                // 忽略
            }
            log((previousStep || '当前学习步骤') + '完成，点击“' + nextLabel + '”');
            next.click();

            let currentStep = '';
            let ready = false;
            const deadline = Date.now() + Math.max(3000, clampNumber(settings.stepWaitTimeoutMs, 3000, 600000, 120000));
            while (!stopped && Date.now() < deadline) {
                await sleep(500);
                currentStep = app._currentStepTitle();
                if (currentStep !== previousStep && currentStep) {
                    ready = true;
                    break;
                }
                // 下一章的第一个任务点可能是文档/讨论等，标题仍为空；
                // 用 iframe 地址或页面标题是否变化判断新任务点是否已经加载。
                if (app._stepSignature() !== previousSignature) {
                    ready = true;
                    break;
                }
                if (currentStep === '视频') {
                    app._videoEl = null;
                    if (app._getVideoEl()) {
                        ready = true;
                        break;
                    }
                }
            }
            if (!ready) {
                app._nextUnitPending = false;
                throw new Error('点击“' + nextLabel + '”后等待超时，新学习步骤仍未加载完成；当前页签：' + (currentStep || '未显示'));
            }

            app._nextUnitPending = false;
            app._videoEl = null;
            try {
                app._initCellData();
            } catch (error) {
                // 忽略目录刷新失败
            }
            app.play();
        }

        async function runQuiz(reason) {
            if (quizBusy) {
                log('已有答题流程进行中，忽略本次请求', 'warn');
                return;
            }
            if (reason !== 'manual' && !settings.autoAnswerQuiz) return;
            if (reason !== 'manual' && autoPausedForStep) return;
            if (reason === 'manual') autoPausedForStep = false;

            quizBusy = true;
            app._quizPhase = 'waiting';

            try {
                if (quizCompleted()) {
                    log('检测到当前章节测验已完成，直接进入下一节');
                    await goToNextStep();
                    return;
                }

                log('已进入章节测验，等待题目与提交按钮加载…');
                const questions = await waitForQuizQuestions(isStopped);
                if (!questions) {
                    log('测验已完成，进入下一节');
                    await goToNextStep();
                    return;
                }
                if (questions.length > clampNumber(settings.maxQuizQuestions, 1, 200, 50)) {
                    throw new Error('题目数量超过上限（' + settings.maxQuizQuestions + '），已停止自动提交');
                }

                const docs = new Set(questions.map((question) => question.doc));
                if (docs.size !== 1) throw new Error('题目分布在多个框架中，已停止自动提交');

                const countText = clean(renderedText(questions[0].doc.body)).match(/题量\s*[:：]\s*(\d+)/);
                if (countText && Number(countText[1]) !== questions.length) {
                    throw new Error('页面显示 ' + countText[1] + ' 道题，脚本只识别 ' + questions.length + ' 道，已停止提交');
                }

                const signature = quizSignature(questions);
                if (attemptedQuizzes.has(signature)) throw new Error('本次测验已经尝试提交过，已停止重复操作');
                if (preparedQuizzes.has(signature)) {
                    log('答案已经选好，等待手动提交', 'warn');
                    return;
                }

                app._quizPhase = 'answering';
                log('识别到 ' + questions.length + ' 道题，开始作答');
                const answers = await resolveAnswers(questions);

                const table = questions.map((question, index) => ({
                    题号: index + 1,
                    题型: question.kind,
                    答案: answers.get(index + 1).letters.join(''),
                    来源: answers.get(index + 1).source,
                }));
                try {
                    console.table(table);
                } catch (error) {
                    // 某些环境没有 console.table
                }
                log('答案：' + table.map((row) => row['题号'] + '.' + row['答案'] + '(' + row['来源'] + ')').join(' ').slice(0, 600));

                app._quizPhase = 'selecting';
                await selectAnswers(questions, answers, isStopped);

                if (!settings.autoSubmit) {
                    preparedQuizzes.add(signature);
                    log('答案已选好，自动提交已关闭；请人工确认后手动提交', 'warn');
                    return;
                }

                attemptedQuizzes.add(signature);
                app._quizPhase = 'submitting';
                await submitQuiz(questions[0].doc, isStopped, log);
                await waitForQuizCompleted(isStopped, log);

                log('测验已完成，进入下一节', 'ok');
                await goToNextStep();
            } catch (error) {
                if (stopped) return;
                console.error('章节测验自动作答停止:', error);
                app._lastError = { message: error.message, at: Date.now() };
                log('答题停止：' + error.message, 'error');
                if (reason !== 'manual') autoPausedForStep = true;
            } finally {
                quizBusy = false;
                app._quizPhase = 'idle';
            }
        }

        async function runVideoQuiz(reason) {
            if (stopped) return;
            if (videoQuizBusy) {
                log('已有视频弹题流程进行中，忽略本次请求', 'warn');
                return;
            }
            if (reason !== 'manual' && (!settings.autoAnswerVideoQuiz || videoPausedForStep)) return;

            const containers = findVideoQuizContainers();
            if (!containers.length) {
                if (reason === 'manual') log('当前没有检测到视频弹题', 'warn');
                return;
            }
            let container = containers[0];
            let questions = extractVideoQuizQuestions(container);
            if (!questions.length) {
                if (reason === 'manual') log('检测到视频弹题，但没有识别到题目；请确认弹窗已展开', 'warn');
                return;
            }
            const signature = quizSignature(questions);
            if (attemptedVideoQuizzes.has(signature)) {
                if (reason !== 'manual') {
                    log('这道视频弹题已经自动尝试过，请手动处理', 'warn');
                    return;
                }
                // 用户在面板点“立即答题”时允许重新尝试，便于自动重试耗尽后人工触发。
                attemptedVideoQuizzes.delete(signature);
                log('已按手动请求重新尝试视频弹题', 'warn');
            }
            if (preparedVideoQuizzes.has(signature)) {
                if (reason === 'manual') log('视频弹题答案已经选好，请手动提交', 'warn');
                return;
            }
            if (reason === 'manual') videoPausedForStep = false;

            const maxAttempts = Math.max(1, Math.min(5, Math.round(Number(settings.videoQuizMaxAttempts) || DEFAULT_SETTINGS.videoQuizMaxAttempts)));
            let attempt = 0;
            let previousAnswers = null;
            let answers = null;
            let outcome = null;
            let submitted = false;

            videoQuizBusy = true;
            app._quizMode = 'video';
            app._quizPhase = 'waiting';
            try {
                while (attempt < maxAttempts) {
                    if (stopped) return;
                    attempt++;

                    if (attempt > 1) {
                        const ready = await waitForVideoQuizSubmitForRetry(container, isStopped, log);
                        if (!ready) {
                            if (outcome && outcome.continueEl) {
                                log('平台没有提供重试界面，只能继续播放；已自动继续', 'warn');
                                outcome.continueEl.click();
                                await sleep(600);
                                try {
                                    if (container.isConnected && visible(container)) container.style.display = 'none';
                                } catch (error) {
                                    // 忽略
                                }
                                await resumeVideoAfterQuiz(app, log);
                            } else {
                                log('视频弹题答错，但平台没有提供可重做的作答界面；请手动改答案或点“返回重做”', 'warn');
                                if (reason !== 'manual') videoPausedForStep = true;
                            }
                            return;
                        }
                        container = ready.container;
                        questions = extractVideoQuizQuestions(container);
                        if (!questions.length) throw new Error('重试时没有识别到视频弹题题目');
                        log('开始第 ' + attempt + '/' + maxAttempts + ' 次作答');
                        const requested = await requestAnswers(questions, {
                            previousAnswers: previousAnswers,
                            feedback: '上一次提交被平台判为回答错误',
                        });
                        answers = new Map();
                        requested.forEach((item, index) => {
                            answers.set(index + 1, { letters: item.letters, source: 'AI重试' });
                        });
                        await clearVideoQuizSelections(questions, isStopped);
                    } else {
                        log('检测到视频弹题（' + questions.length + ' 道），开始作答');
                        answers = await resolveAnswers(questions, { saveToBank: false });
                    }

                    const table = questions.map((question, index) => ({
                        题号: index + 1,
                        题型: question.kind,
                        答案: answers.get(index + 1).letters.join(''),
                        来源: answers.get(index + 1).source,
                    }));
                    try {
                        console.table(table);
                    } catch (error) {
                        // 某些环境没有 console.table
                    }
                    log('视频弹题答案（第 ' + attempt + ' 次）：' +
                        table.map((row) => row['题号'] + '.' + row['答案'] + '(' + row['来源'] + ')').join(' ').slice(0, 600));

                    app._quizPhase = 'selecting';
                    await selectVideoQuizAnswers(questions, answers, isStopped);

                    if (!settings.autoSubmit) {
                        preparedVideoQuizzes.add(signature);
                        log('视频弹题答案已选好，自动提交已关闭；请手动提交后继续播放', 'warn');
                        return;
                    }

                    app._quizPhase = 'submitting';
                    let submit = findVideoQuizSubmit(container);
                    if (!submit) {
                        // 选项点击后平台可能短暂重绘操作栏，稍等再找一次。
                        await sleep(300);
                        submit = findVideoQuizSubmit(container);
                    }
                    if (!submit) throw new Error('未找到视频弹题的“提交”按钮');
                    if (!submitted) {
                        attemptedVideoQuizzes.add(signature);
                        submitted = true;
                    }
                    log('第 ' + attempt + '/' + maxAttempts + ' 次点击视频弹题的“提交”');
                    submit.click();

                    outcome = await waitForVideoQuizOutcome(container, isStopped, log);
                    if (outcome.correct) {
                        saveAnswersToBank(questions, answers);
                        log('视频弹题第 ' + attempt + ' 次回答正确', 'ok');
                        break;
                    }
                    if (outcome.wrong) {
                        // 本轮整套答案判错，删掉题库里的这些题，避免下次又命中错答案。
                        forgetAnswersFromBank(questions);
                        // 清掉旧的对错标记，避免重试提交后仍被当成上一轮的“错误”或“正确”。
                        resetVideoQuizResultMarks(container);
                        previousAnswers = answers;
                        if (attempt < maxAttempts) {
                            log('视频弹题第 ' + attempt + ' 次回答错误，准备第 ' + (attempt + 1) + ' 次尝试', 'warn');
                            continue;
                        }
                        log('视频弹题已重试 ' + attempt + ' 次仍回答错误，请在弹窗中手动重做', 'error');
                        if (reason !== 'manual') videoPausedForStep = true;
                        return;
                    }
                    if (outcome.type === 'closed') {
                        log('视频弹题已提交并关闭', 'ok');
                        break;
                    }
                    if (outcome.type === 'timeout') {
                        log('视频弹题结果未确认，请手动检查弹窗', 'warn');
                        if (reason !== 'manual') videoPausedForStep = true;
                        return;
                    }
                    log('视频弹题已提交，但没有识别到明确的对错标记', 'warn');
                    break;
                }

                if (outcome && outcome.continueEl) {
                    log('点击“继续播放”恢复视频');
                    outcome.continueEl.click();
                    await sleep(600);
                    try {
                        // 有些页面点了“继续播放”后只把弹题内容清空，外层 .tkTopic 仍然留在 DOM 里，
                        // 会一直被 hasOpenVideoQuiz() 当作未处理弹题，进而卡住 video.ended 的自动切节。
                        if (container.isConnected && visible(container)) {
                            container.style.display = 'none';
                            log('视频弹题浮层已关闭');
                        }
                    } catch (error) {
                        // 忽略
                    }
                }
                if (outcome && (outcome.continueEl || outcome.type === 'closed' || outcome.correct)) {
                    await resumeVideoAfterQuiz(app, log);
                }
            } catch (error) {
                if (stopped) return;
                console.error('视频弹题自动作答停止:', error);
                app._lastError = { message: error.message, at: Date.now() };
                log('视频弹题停止：' + error.message, 'error');
                if (reason !== 'manual') videoPausedForStep = true;
            } finally {
                videoQuizBusy = false;
                app._quizMode = 'quiz';
                app._quizPhase = 'idle';
            }
        }

        const originalDestroy = app.destroy.bind(app);
        app.destroy = function () {
            if (stopped) return;
            stopped = true;
            if (watchdog) {
                clearInterval(watchdog);
                watchdog = null;
            }
            if (app._panel) {
                try {
                    app._panel.destroy();
                } catch (error) {
                    // 忽略
                }
            }
            originalDestroy();
        };

        watchdog = setInterval(() => {
            if (stopped) return;
            let title = '';
            try {
                title = app._currentStepTitle();
            } catch (error) {
                return;
            }
            if (title !== lastStepTitle) {
                lastStepTitle = title;
                autoPausedForStep = false;
                videoPausedForStep = false;
            }
            // 大章结束时可能出现“本章已完成/进入下一章”提示，先点掉再处理其它步骤。
            try {
                if (!quizBusy && !videoQuizBusy && !hasOpenVideoQuiz() && app._handleChapterFinishTip()) {
                    log('检测到章节完成提示，已点击进入下一章', 'ok');
                    return;
                }
            } catch (error) {
                // 忽略提示处理异常
            }
            if (title === '章节测验') {
                if (!settings.autoAnswerQuiz || quizBusy || autoPausedForStep) return;
                runQuiz('watchdog');
                return;
            }
            // 视频弹题可能出现在同一视频的任意时间点，不能只依赖步骤标题
            // （部分页面 iframe 的 num 参数不会随播放器刷新，标题可能为空）。
            if (!settings.autoAnswerVideoQuiz || videoQuizBusy || videoPausedForStep) return;
            if (!hasOpenVideoQuiz()) return;
            runVideoQuiz('watchdog');
        }, 3000);
    }

    // ============================================================
    // 控制面板
    // ============================================================

    const PANEL_TEMPLATE = [
        '<style>',
        ':host{all:initial}',
        '.panel{width:306px;background:#1d2330;color:#e6e9f0;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);',
        'font:12px/1.6 "Microsoft YaHei","PingFang SC",Arial,sans-serif;overflow:hidden}',
        '.panel.collapsed{width:auto}.panel.collapsed .panel-body{display:none}',
        '.panel-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#273044;user-select:none}',
        '.dot{width:9px;height:9px;border-radius:50%;background:#7f8a9e;flex:0 0 auto}',
        '.dot.ok{background:#46c37b}.dot.warn{background:#f0a83c}.dot.err{background:#ef5350}.dot.busy{background:#4f9cf9}',
        '.title{font-weight:600;font-size:12px;flex:1 1 auto;white-space:nowrap}',
        '.mini{border:0;background:transparent;color:#9aa4b8;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}',
        '.panel-body{padding:8px 10px 10px}',
        '.row{display:flex;align-items:center;gap:6px;margin-bottom:6px}',
        '.row>label{display:flex;align-items:center;gap:4px;white-space:nowrap}',
        '.grow{flex:1 1 auto;min-width:0}',
        'input[type=password],input[type=text],input[type=number]{background:#151a24;border:1px solid #39445c;color:#e6e9f0;',
        'border-radius:5px;padding:3px 6px;font:12px/1.4 inherit;min-width:0}',
        'input[type=number]{width:54px}',
        'button.act{background:#3b6fd4;color:#fff;border:0;border-radius:5px;padding:4px 9px;cursor:pointer;font-size:12px}',
        'button.act.ghost{background:#2b3448;color:#c9d1e2}',
        '.status{color:#aab3c5;margin:6px 0 4px}',
        '.status b{color:#e6e9f0;font-weight:600}',
        '.log{max-height:88px;overflow:auto;background:#141922;border-radius:6px;padding:5px 7px;color:#9aa4b8;',
        'font:11px/1.5 Consolas,Menlo,monospace}',
        '.log div{white-space:pre-wrap;word-break:break-all}',
        '.log .err{color:#ff8a80}.log .warn{color:#ffca7a}.log .ok{color:#7ddcaa}',
        '.bank{color:#8993a8;font-size:11px;margin-top:5px;display:flex;align-items:center;gap:6px}',
        'a.link{color:#7ea6ff;text-decoration:none;cursor:pointer}',
        '</style>',
        '<div class="panel">',
        '<div class="panel-head"><span class="dot"></span><span class="title">学习通助手 V4</span>',
        '<button class="mini" data-act="collapse" title="折叠/展开">—</button></div>',
        '<div class="panel-body">',
        '<div class="row">',
        '<label><input type="checkbox" data-field="autoplay">自动播放</label>',
        '<label><input type="checkbox" data-field="autoAnswerQuiz">自动答题</label>',
        '<label title="自动作答视频中的弹题"><input type="checkbox" data-field="autoAnswerVideoQuiz">视频题</label>',
        '<label><input type="checkbox" data-field="autoSubmit">自动提交</label>',
        '</div>',
        '<div class="row"><span>倍速</span><input type="number" min="1" max="16" step="0.5" data-field="playbackRate">',
        '<label><input type="checkbox" data-field="muteVideo">静音</label>',
        '<label><input type="checkbox" data-field="useBank">题库优先</label></div>',
        '<div class="row"><input type="password" class="grow" data-field="apiKey" placeholder="DeepSeek API Key（sk-...）" autocomplete="off">',
        '<button class="act" data-act="saveKey">保存</button></div>',
        '<div class="row"><button class="act" data-act="answer">立即答题</button>',
        '<button class="act ghost" data-act="inspect">识别题目</button>',
        '<button class="act ghost" data-act="clearBank">清空题库</button></div>',
        '<div class="status">状态：<b data-status>初始化</b></div>',
        '<div class="log" data-log></div>',
        '<div class="bank"><span data-bank>题库 0 条</span><span class="grow"></span>',
        '<a class="link" data-act="advanced">高级设置</a></div>',
        '<div class="advanced" hidden style="margin-top:6px">',
        '<div class="row"><span>接口</span><input type="text" class="grow" data-field="apiBase" placeholder="https://api.deepseek.com"></div>',
        '<div class="row"><span>模型</span><input type="text" class="grow" data-field="model" placeholder="deepseek-chat"></div>',
        '<div class="row" title="视频弹题答错后最多尝试几次"><span>视频题尝试</span>',
        '<input type="number" min="1" max="5" step="1" data-field="videoQuizMaxAttempts"><span>次</span></div>',
        '</div>',
        '</div>',
        '</div>',
    ].join('');

    function createControlPanel(app) {
        if (!PAGE.document.body) return null;
        const existing = PAGE.document.getElementById(PANEL_HOST_ID);
        if (existing) existing.remove();

        const host = PAGE.document.createElement('div');
        host.id = PANEL_HOST_ID;
        host.style.cssText = 'all:initial;position:fixed;right:14px;bottom:14px;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = PANEL_TEMPLATE;
        const panel = shadow.querySelector('.panel');
        const dot = shadow.querySelector('.dot');
        const statusText = shadow.querySelector('[data-status]');
        const logBox = shadow.querySelector('[data-log]');
        const bankText = shadow.querySelector('[data-bank]');
        const advanced = shadow.querySelector('.advanced');

        panel.classList.toggle('collapsed', Boolean(settings.panelCollapsed));

        const field = (name) => shadow.querySelector('[data-field="' + name + '"]');
        const checkboxKeys = ['autoplay', 'autoAnswerQuiz', 'autoAnswerVideoQuiz', 'autoSubmit', 'muteVideo', 'useBank'];
        const reflect = () => {
            checkboxKeys.forEach((key) => {
                const input = field(key);
                if (input) input.checked = Boolean(settings[key]);
            });
            const rate = field('playbackRate');
            if (rate) rate.value = String(settings.playbackRate);
            const keyInput = field('apiKey');
            if (keyInput && !keyInput.dataset.touched) keyInput.value = apiKey;
            const base = field('apiBase');
            if (base) base.value = settings.apiBase;
            const model = field('model');
            if (model) model.value = settings.model;
            const retryInput = field('videoQuizMaxAttempts');
            if (retryInput) retryInput.value = String(settings.videoQuizMaxAttempts);
            bankText.textContent = '题库 ' + bankCount + ' 条';
        };

        const commit = () => {
            saveSettings();
            applySettings(app);
        };

        checkboxKeys.forEach((key) => {
            const input = field(key);
            if (!input) return;
            input.addEventListener('change', () => {
                settings[key] = input.checked;
                commit();
            });
        });

        const rateInput = field('playbackRate');
        rateInput.addEventListener('change', () => {
            settings.playbackRate = clampNumber(rateInput.value, 1, 16, DEFAULT_SETTINGS.playbackRate);
            rateInput.value = String(settings.playbackRate);
            commit();
        });

        const retryInput = field('videoQuizMaxAttempts');
        retryInput.addEventListener('change', () => {
            settings.videoQuizMaxAttempts = clampNumber(retryInput.value, 1, 5, DEFAULT_SETTINGS.videoQuizMaxAttempts);
            retryInput.value = String(settings.videoQuizMaxAttempts);
            commit();
        });

        const keyInput = field('apiKey');
        keyInput.addEventListener('input', () => {
            keyInput.dataset.touched = '1';
        });
        const saveKey = () => {
            apiKey = String(keyInput.value || '').trim();
            storageSetText(STORE.apiKey, apiKey);
            keyInput.dataset.touched = '';
            keyInput.value = apiKey;
            log(apiKey ? 'API Key 已保存' : 'API Key 已清空', apiKey ? 'ok' : 'warn');
        };
        shadow.querySelector('[data-act="saveKey"]').addEventListener('click', saveKey);
        keyInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') saveKey();
        });

        field('apiBase').addEventListener('change', (event) => {
            settings.apiBase = String(event.target.value || '').trim() || DEFAULT_SETTINGS.apiBase;
            event.target.value = settings.apiBase;
            commit();
        });
        field('model').addEventListener('change', (event) => {
            settings.model = String(event.target.value || '').trim() || DEFAULT_SETTINGS.model;
            event.target.value = settings.model;
            commit();
        });

        shadow.querySelector('[data-act="collapse"]').addEventListener('click', () => {
            settings.panelCollapsed = !panel.classList.contains('collapsed');
            panel.classList.toggle('collapsed', settings.panelCollapsed);
            commit();
        });

        shadow.querySelector('[data-act="advanced"]').addEventListener('click', () => {
            advanced.hidden = !advanced.hidden;
        });

        shadow.querySelector('[data-act="answer"]').addEventListener('click', () => {
            if (typeof app.answerQuiz === 'function') app.answerQuiz();
        });

        shadow.querySelector('[data-act="inspect"]').addEventListener('click', () => {
            const result = typeof app.inspectQuiz === 'function' ? app.inspectQuiz() : [];
            console.log('当前识别到的题目：', result);
            if (!result.length) {
                log('没有识别到题目：请确认当前在章节测验或视频弹题页面，且题目已加载', 'warn');
                return;
            }
            result.forEach((item) => {
                log(item.id + '. [' + item.type + '] ' + item.question.slice(0, 60) + ' | ' + item.options.join(' / '));
            });
        });

        shadow.querySelector('[data-act="clearBank"]').addEventListener('click', () => {
            if (!PAGE.confirm('确定清空本地题库？清空后所有题目都会重新请求 AI。')) return;
            if (typeof app.clearAnswerBank === 'function') app.clearAnswerBank();
            bankText.textContent = '题库 0 条';
        });

        function log(message, level) {
            const line = PAGE.document.createElement('div');
            line.className = level || 'info';
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            line.textContent = '[' + time + '] ' + message;
            logBox.appendChild(line);
            while (logBox.childElementCount > 40) logBox.removeChild(logBox.firstElementChild);
            logBox.scrollTop = logBox.scrollHeight;
        }

        let lastBankText = '';
        function refreshStatus() {
            let text = '待机';
            let tone = '';
            try {
                const phase = app._quizPhase || 'idle';
                const mode = app._quizMode === 'video' ? '视频弹题' : '章节测验';
                if (phase === 'waiting') { text = mode + ' · 等待题目'; tone = 'busy'; }
                else if (phase === 'answering') { text = mode + ' · AI 作答中'; tone = 'busy'; }
                else if (phase === 'selecting') { text = mode + ' · 填写答案'; tone = 'busy'; }
                else if (phase === 'submitting') { text = mode + ' · 提交中'; tone = 'busy'; }
                else {
                    const step = app._currentStepTitle();
                    if (hasOpenVideoQuiz()) {
                        text = settings.autoAnswerVideoQuiz ? '视频弹题待处理' : '视频弹题（已关闭自动）';
                        tone = 'warn';
                    } else if (step === '章节测验') { text = '章节测验页面'; tone = 'warn'; }
                    else if (app._isPlaying) { text = '视频播放中'; tone = 'ok'; }
                    else if (step) { text = step + '页面'; }
                }
                if (!apiKey) text += ' · 未配置 Key';
            } catch (error) {
                text = '页面状态读取失败';
                tone = 'err';
            }
            statusText.textContent = text;
            dot.className = 'dot' + (tone ? ' ' + tone : '');
            const bankLine = '题库 ' + bankCount + ' 条';
            if (bankLine !== lastBankText) {
                bankText.textContent = bankLine;
                lastBankText = bankLine;
            }
        }

        const timer = setInterval(refreshStatus, 1000);

        const api = {
            log,
            refresh: reflect,
            destroy() {
                clearInterval(timer);
                host.remove();
                if (app._panel === api) app._panel = null;
            },
        };

        reflect();
        refreshStatus();
        (PAGE.document.body || PAGE.document.documentElement).appendChild(host);
        app._panel = api;
        bankCount = Object.keys(loadBank()).length;
        bankText.textContent = '题库 ' + bankCount + ' 条';
        log('脚本已加载，' + (apiKey ? 'API Key 已保存' : '请先填写 DeepSeek API Key'), apiKey ? 'ok' : 'warn');
        return api;
    }

    // ============================================================
    // 播放器（原 V3 逻辑）
    // ============================================================

    function initializePlayer() {
        const app = {
            configs: {
                playbackRate: settings.playbackRate,
                autoplay: settings.autoplay,
                muteVideo: settings.muteVideo,
                retryInterval: 2000,
                maxRetries: 10,
                videoCheckInterval: 1000,
                guardNoProgressMs: 7000,
                guardResumeCooldownMs: 1500,
                autoAdvanceNoVideo: settings.autoAdvanceNoVideo,
            },
            _videoEl: null,
            _treeContainerEl: null,
            _isPlaying: false,
            _currentRetryCount: 0,
            _checkInterval: null,
            _eventVideoEl: null,
            _boundVideoHandlers: null,
            _nextUnitPending: false,
            _skipCurrentPending: false,
            _chapterAdvanceTimes: 0,
            _quizPhase: 'idle',
            _panel: null,
            _cellData: {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: '',
            },
            get cellData() {
                return this._cellData;
            },
            run() {
                console.log('%c=== 学习通自动刷课 + 刷题助手 V4 启动 ===', 'color:#4CAF50;font-size:16px;font-weight:bold');
                this._nextUnitPending = false;
                this._chapterAdvanceTimes = 0;
                this._quizPhase = 'idle';
                this._getTreeContainer();
                this._initCellData();
                console.log('当前学习步骤：' + (this._currentStepTitle() || '等待页面加载'));
                this._videoEl = null;
                this._getVideoEl();
                this._clearCheckInterval();
                this._bindStepNavigation();
                this.play();
            },
            async nextUnit() {
                if (this._nextUnitPending) {
                    console.warn('%c已有小节切换正在进行，忽略重复请求', 'color:#FF9800');
                    return;
                }
                this._nextUnitPending = true;
                this._clearCheckInterval();
                this._videoEl = null;
                this._isPlaying = false;
                console.log('%c=== 准备切换到下一小节 ===', 'color:#2196F3;font-size:14px');
                try {
                    // 大章结束时平台可能弹出“本章已完成”提示，先点掉它，
                    // 否则目录/播放器会被遮罩挡住，看起来像不会进入下一章。
                    // 有些“进入下一章”按钮本身就会跳转，此时不能再点一次目录，
                    // 否则会跳过下一章的第一节。
                    const beforeTipSignature = this._stepSignature();
                    if (this._handleChapterFinishTip()) {
                        console.log('%c检测到章节完成提示，等待页面进入下一章…', 'color:#607D8B');
                        let tipChanged = false;
                        for (let i = 0; i < 6; i++) {
                            await sleep(500);
                            if (this._stepSignature() !== beforeTipSignature) {
                                tipChanged = true;
                                break;
                            }
                        }
                        if (tipChanged) {
                            console.log('%c章节提示已自动进入下一章，无需再点击目录', 'color:#4CAF50');
                            this._nextUnitPending = false;
                            try {
                                this._initCellData();
                            } catch (error) {
                                // 忽略目录刷新失败
                            }
                            if (this.configs.autoplay) this.play();
                            return;
                        }
                    }

                    const leaves = this._tocLeaves();
                    if (!leaves.length) throw new Error('课程目录中没有找到可点击的小节');

                    let currentIndex = this._resolveTocIndex(leaves);
                    if (currentIndex < 0) {
                        currentIndex = 0;
                        console.warn('%c未定位到当前小节，尝试从目录第一个节点继续', 'color:#FF9800');
                    }
                    console.log('%c目录共 ' + leaves.length + ' 个小节，当前：' +
                        leaves[currentIndex].title + '（第 ' + (currentIndex + 1) + ' 个）', 'color:#607D8B');

                    // 关键：不再按“章 li / 章内节”分组，而是把整棵目录按 DOM 顺序扁平化。
                    // 这样最后一个小节之后自然就是下一大章的第一个小节，跨章不需要特殊分支。
                    for (let i = currentIndex + 1; i < leaves.length; i++) {
                        const target = leaves[i];
                        const targetState = this._tocLeafState(target);
                        if (targetState.done) {
                            console.log('%c跳过' + targetState.reason + '小节：' + target.title, 'color:#8993A8');
                            continue;
                        }
                        this._openTocLeaf(target, i);
                        return;
                    }

                    console.warn('%c目录中没有下一个未完成小节，尝试页面“下一节/下一章”按钮', 'color:#FF9800');
                    if (this._clickPageNextButton()) return;

                    this._nextUnitPending = false;
                    console.log('%c=====================================', 'color:#4CAF50;font-size:16px');
                    console.log('%c==============本课程学习完成了==============', 'color:#4CAF50;font-size:16px;font-weight:bold');
                    console.log('%c=====================================', 'color:#4CAF50;font-size:16px');
                } catch (error) {
                    this._nextUnitPending = false;
                    console.error('切换下一小节失败:', error);
                    // 目录结构异常时，最后再尝试一次平台自己的“下一节/下一章”按钮。
                    if (!this._clickPageNextButton()) {
                        console.warn('%c自动切换失败，请把控制台日志反馈给脚本维护者', 'color:#FF9800');
                    }
                }
            },
            _tocLeaves() {
                const el = this._getTreeContainer();
                const leaves = [];
                el.find('.posCatalog_select').each((index, node) => {
                    const $node = $(node);
                    // 章头（firstLayer / posCatalog_title）即使带 posCatalog_name 也不能当小节点击。
                    if ($node.hasClass('firstLayer') || $node.find('.posCatalog_title').length) return;
                    const span = $node.find('.posCatalog_name').get(0);
                    if (!span) return;
                    const title = clean($(span).attr('title') || $(span).text());
                    if (!title) return;
                    leaves.push({ node: node, span: span, title: title });
                });
                return leaves;
            },
            _resolveTocIndex(leaves) {
                const activeIndex = leaves.findIndex((leaf) => $(leaf.node).hasClass('posCatalog_active'));
                if (this._lastTocTitle) {
                    let recordedIndex = leaves.findIndex((leaf) => leaf.title === this._lastTocTitle);
                    if (recordedIndex < 0) {
                        recordedIndex = leaves.findIndex((leaf) =>
                            leaf.title.indexOf(this._lastTocTitle) >= 0 || this._lastTocTitle.indexOf(leaf.title) >= 0);
                    }
                    if (recordedIndex >= 0) {
                        const recentlyClicked = this._lastTocClickAt && Date.now() - this._lastTocClickAt < 10000;
                        // 平台在切换小节后经常不更新 posCatalog_active（外部实测坑），
                        // 刚由脚本点击过时以脚本记录的位置为准；用户手动切节超过 10 秒后则跟随 active。
                        if (!recentlyClicked && activeIndex >= 0 && activeIndex !== recordedIndex) {
                            return activeIndex;
                        }
                        return recordedIndex;
                    }
                }
                return activeIndex;
            },
            _tocLeafScopes(leaf) {
                const scopes = [];
                const push = (el) => {
                    if (el && scopes.indexOf(el) < 0) scopes.push(el);
                };
                push(leaf.node);
                const doc = leaf.node.ownerDocument || document;
                let row = null;
                let parent = leaf.node.parentElement;
                while (parent && parent !== doc.body) {
                    if (parent.tagName === 'LI' || parent.classList.contains('posCatalog_level')) {
                        row = parent;
                        push(parent);
                        break;
                    }
                    parent = parent.parentElement;
                }
                if (!row && leaf.node.parentElement) push(leaf.node.parentElement);
                // 有些模板把任务点计数/完成图标放在 li 的外层容器里，多扫一层；
                // _tocScopeOwns 会按最近的 li 过滤，不会把兄弟节点的图标算进来。
                if (row && row.parentElement && row.parentElement !== doc.body) push(row.parentElement);
                return scopes;
            },
            _tocScopeOwns(leaf, el) {
                const owner = el.closest ? el.closest('.posCatalog_select') : null;
                if (owner) return owner === leaf.node;
                const leafRow = leaf.node.closest ? leaf.node.closest('li') : null;
                const elRow = el.closest ? el.closest('li') : null;
                return !leafRow || elRow === leafRow;
            },
            _tocLeafState(leaf) {
                const scopes = this._tocLeafScopes(leaf);
                const ownClass = String(leaf.node.className || '');
                const titleClass = String((leaf.span && leaf.span.className) || '');
                const doneClassPattern = /(?:^|[\s_-])(?:completed|complete|finished|finish|done)(?:$|[\s_-])/i;
                if ((doneClassPattern.test(ownClass) && !/unfinish/i.test(ownClass)) ||
                    (doneClassPattern.test(titleClass) && !/unfinish/i.test(titleClass))) {
                    return { done: true, reason: '已完成' };
                }
                for (const scope of scopes) {
                    if (scope === leaf.node) continue;
                    // 只在“这一行只有一个叶子节点”时看行级 class，避免把整章/整棵目录
                    // 的 completed class 误当成每个小节的完成状态。
                    if (scope.querySelectorAll('.posCatalog_select').length !== 1) continue;
                    const rowClass = String(scope.className || '');
                    if (doneClassPattern.test(rowClass) && !/unfinish/i.test(rowClass)) {
                        return { done: true, reason: '已完成' };
                    }
                }

                for (const scope of scopes) {
                    const icons = scope.querySelectorAll(
                        '.icon_Completed, .icon-completed, [class*="icon_Completed"], [class*="icon-completed"], ' +
                        'img[alt*="完成"], img[src*="Completed"], img[src*="completed"], img[src*="finish"]'
                    );
                    for (const icon of icons) {
                        if (!this._tocScopeOwns(leaf, icon)) continue;
                        const src = String(icon.getAttribute('src') || '');
                        if (/unfinish/i.test(src)) continue;
                        return { done: true, reason: '已完成' };
                    }

                    const labelled = scope.querySelectorAll('[data-status], [aria-label], [title]');
                    for (const el of labelled) {
                        if (!this._tocScopeOwns(leaf, el)) continue;
                        if (el === leaf.node || el === leaf.span || (leaf.span && leaf.span.contains(el)) ||
                            el.classList.contains('posCatalog_name')) continue;
                        const text = [
                            el.getAttribute('data-status'),
                            el.getAttribute('aria-label'),
                            el.getAttribute('title'),
                        ].filter(Boolean).join(' ');
                        if (text && /已完成|^完成$|completed|finished|done/i.test(text) && !/未完成|unfinish/i.test(text)) {
                            return { done: true, reason: '已完成' };
                        }
                    }

                    const countEls = scope.querySelectorAll(
                        'input.jobUnfinishCount, input[name*="jobUnfinish"], input[class*="jobUnfinish"], ' +
                        '.jobUnfinishCount, [class*="jobUnfinishCount"], [class*="jobunfinishcount"], ' +
                        '[data-unfinish-count], [data-unfinishcount], [data-job-count], [data-jobcount], ' +
                        '[data-task-count], [data-taskcount]'
                    );
                    for (const el of countEls) {
                        if (!this._tocScopeOwns(leaf, el)) continue;
                        const raw = (el.value !== undefined && el.value !== null && el.value !== '')
                            ? el.value
                            : (el.getAttribute('data-unfinish-count') ||
                                el.getAttribute('data-unfinishcount') ||
                                el.getAttribute('data-job-count') ||
                                el.getAttribute('data-jobcount') ||
                                el.getAttribute('data-task-count') ||
                                el.getAttribute('data-taskcount') ||
                                el.getAttribute('value') ||
                                el.getAttribute('data-value') ||
                                el.getAttribute('title') ||
                                el.getAttribute('aria-label') ||
                                el.textContent);
                        const match = String(raw == null ? '' : raw).match(/-?\d+(?:\.\d+)?/);
                        if (match && Number(match[0]) === 0) {
                            return { done: true, reason: '待完成任务点为 0' };
                        }
                    }

                    const badgeEls = scope.querySelectorAll('em, i, span, b, strong, small, label');
                    for (const el of badgeEls) {
                        if (!this._tocScopeOwns(leaf, el)) continue;
                        if (el === leaf.span || (leaf.span && leaf.span.contains(el)) || el.classList.contains('posCatalog_name')) continue;
                        const text = clean(el.textContent || '');
                        if (!text || text.length > 8) continue;
                        if (/^(?:已完成|完成)$/.test(text)) {
                            return { done: true, reason: '已完成' };
                        }
                        if (/^(?:0|0\s*(?:个|项|任务点|待完成|个任务点|个待完成))$/.test(text) ||
                            /^0\s*\/\s*0$/.test(text)) {
                            return { done: true, reason: '待完成任务点为 0' };
                        }
                    }
                }
                return { done: false, reason: '' };
            },
            _tocLeafDone(leaf) {
                return this._tocLeafState(leaf).done;
            },
            _currentTocLeaf() {
                let leaves = [];
                try {
                    leaves = this._tocLeaves();
                } catch (error) {
                    return null;
                }
                if (!leaves.length) return null;
                if (this._lastTocTitle) {
                    let index = leaves.findIndex((leaf) => leaf.title === this._lastTocTitle);
                    if (index < 0) {
                        index = leaves.findIndex((leaf) =>
                            leaf.title.indexOf(this._lastTocTitle) >= 0 || this._lastTocTitle.indexOf(leaf.title) >= 0);
                    }
                    if (index >= 0) return leaves[index];
                }
                return leaves.find((leaf) => $(leaf.node).hasClass('posCatalog_active')) || null;
            },
            _currentLeafSkippable() {
                const leaf = this._currentTocLeaf();
                if (!leaf) return null;
                const state = this._tocLeafState(leaf);
                return state.done ? { leaf: leaf, state: state } : null;
            },
            _expandTocAncestors(node) {
                let parent = node.parentElement;
                while (parent && parent.id !== 'coursetree') {
                    if (parent.tagName === 'UL' && parent.style && parent.style.display === 'none') {
                        parent.style.display = 'block';
                    }
                    parent = parent.parentElement;
                }
            },
            _handleChapterFinishTip() {
                // 防止提示层没有及时消失时，watchdog 每 3 秒重复点击同一个按钮。
                const now = Date.now();
                if (this._lastFinishTipAt && now - this._lastFinishTipAt < 8000) return false;
                const labels = ['进入下一章', '下一章', '继续学习', '继续', '确定'];
                for (const doc of courseDocuments()) {
                    let tips = [];
                    try {
                        tips = Array.from(doc.querySelectorAll('.jobFinishTip, .chapterFinishTip, .finishTip'));
                    } catch (error) {
                        tips = [];
                    }
                    for (const tip of tips) {
                        if (!visible(tip)) continue;
                        for (const label of labels) {
                            const button = findButton(tip, label) || findButton(doc, label);
                            if (!button) continue;
                            console.log('%c章节完成提示：点击“' + label + '”', 'color:#2196F3');
                            this._lastFinishTipAt = now;
                            button.click();
                            return true;
                        }
                    }
                }
                return false;
            },
            _clickPageNextButton() {
                const button = findNextButton();
                if (!button) return false;

                // 防止不是视频的页面（文档/讨论）点击后页面没变化时无限循环。
                const signature = this._stepSignature();
                const now = Date.now();
                if (this._pageNextClickAt && now - this._pageNextClickAt < 20000 && this._pageNextSignature === signature) {
                    console.warn('%c页面“下一节/下一章”按钮点击后没有切换任务点，停止自动跳转', 'color:#FF9800');
                    return false;
                }
                this._pageNextClickAt = now;
                this._pageNextSignature = signature;

                console.log('%c点击页面按钮：' + (textOf(button) || '下一节'), 'color:#2196F3');
                this._nextUnitPending = true;
                this._clearCheckInterval();
                this._videoEl = null;
                this._isPlaying = false;
                try {
                    button.scrollIntoView({ block: 'center' });
                } catch (error) {
                    // 忽略
                }
                button.click();
                setTimeout(() => {
                    this._nextUnitPending = false;
                    try {
                        this._initCellData();
                    } catch (error) {
                        // 忽略目录刷新失败
                    }
                    if (this.configs.autoplay) this.play();
                }, 2500);
                return true;
            },
            _openTocLeaf(leaf, index) {
                if (!leaf || !leaf.span) return false;
                this._lastTocTitle = leaf.title;
                this._lastTocIndex = index;
                this._lastTocClickAt = Date.now();
                this._cellData.currentVideoTitle = leaf.title;
                this._nextUnitPending = true;
                this._clearCheckInterval();
                this._videoEl = null;
                this._isPlaying = false;
                this._expandTocAncestors(leaf.node);

                console.log('%c点击切换到：' + leaf.title + '（目录第 ' + (index + 1) + ' 个）', 'color:#2196F3');
                try {
                    $(leaf.span).click();
                } catch (error) {
                    console.error('点击课程目录失败:', error);
                    this._nextUnitPending = false;
                    return false;
                }

                setTimeout(() => {
                    this._nextUnitPending = false;
                    try {
                        this._initCellData();
                    } catch (error) {
                        // 忽略目录刷新失败
                    }
                    if (this.configs.autoplay) this.play();
                }, 3000);
                return true;
            },
            playCurrentIndex(nCell) {
                const leaves = this._tocLeaves();
                const index = leaves.findIndex((leaf) => leaf.node === nCell || leaf.span === nCell ||
                    (nCell && leaf.node.contains(nCell)));
                if (index >= 0) return this._openTocLeaf(leaves[index], index);
                console.error('%c===========找不到可点击的课程节点，播放下一个视频失败==============', 'color:#F44336');
                return false;
            },
            _clearCheckInterval() {
                if (this._checkInterval) {
                    clearInterval(this._checkInterval);
                    this._checkInterval = null;
                }
            },
            _startVideoMonitoring() {
                this._clearCheckInterval();
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                this._checkInterval = setInterval(() => {
                    this._checkVideoStatus();
                }, this.configs.videoCheckInterval);
            },
            _tryResumePlayback(reason) {
                if (hasOpenVideoQuiz()) {
                    console.log('%c检测到视频弹题，暂停自动恢复播放', 'color:#FF9800');
                    return;
                }
                const now = Date.now();
                if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) return;
                this._guardLastResumeTs = now;

                const video = this._getVideoEl();
                if (!video || !this._isPlaying) return;

                if (this.configs.muteVideo) {
                    video.muted = true;
                    video.defaultMuted = true;
                    video.volume = 0;
                }
                console.log('%c触发视频保活恢复(' + reason + ')', 'color:#607D8B');
                video.play().catch((error) => {
                    console.warn('直接恢复播放失败，尝试静音恢复:', error);
                    video.muted = true;
                    video.play().catch((err) => {
                        console.error('静音恢复播放失败:', err);
                    });
                });
            },
            _checkVideoStatus() {
                try {
                    const video = this._getVideoEl();
                    if (!video) return;

                    // ended 是“自然播放完毕”的可靠信号，不应依赖 _isPlaying 是否仍为 true；
                    // 弹题后由平台自己继续播放时，_isPlaying 可能没有被重新置位。
                    if (video.ended) {
                        if (hasOpenVideoQuiz()) return;
                        console.log('%c检测到视频结束，准备切换下一个...', 'color:#9C27B0');
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        setTimeout(() => this.nextUnit(), 1000);
                        return;
                    }

                    if (hasOpenVideoQuiz()) return;

                    if (video.paused && this._isPlaying) {
                        console.log('%c检测到视频暂停，尝试恢复播放...', 'color:#FF5722');
                        this._tryResumePlayback('paused');
                    } else if (this._isPlaying && !video.ended) {
                        const now = Date.now();
                        const current = Number(video.currentTime || 0);
                        if (this._guardLastWallTs === 0) {
                            this._guardLastWallTs = now;
                            this._guardLastTime = current;
                        } else {
                            const stalled = Math.abs(current - this._guardLastTime) < 0.01;
                            const stalledMs = now - this._guardLastWallTs;
                            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
                                this._tryResumePlayback('no-progress');
                                this._guardLastWallTs = now;
                                this._guardLastTime = Number(video.currentTime || 0);
                            } else if (!stalled) {
                                this._guardLastWallTs = now;
                                this._guardLastTime = current;
                            }
                        }
                    }

                } catch (error) {
                    console.error('视频状态检查失败:', error);
                }
            },
            _tryTimes: 0,
            _stepAdvanceTimes: 0,
            _stepSwitchAt: 0,
            _stepSwitchPending: false,
            _delayedNextUnitTimer: null,
            _guardLastTime: 0,
            _guardLastWallTs: 0,
            _guardLastResumeTs: 0,
            async play() {
                try {
                    // 平台课程目录里有些节点“待完成任务点为 0”或已经打勾，但点开后
                    // 没有视频/测验，旧逻辑会停在这里。当前节点一旦确定无需再学，
                    // 直接走 nextUnit 的跳过扫描。
                    const skipped = this._currentLeafSkippable();
                    if (skipped && !this._skipCurrentPending) {
                        this._skipCurrentPending = true;
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        console.log('%c当前小节' + skipped.state.reason + '，自动跳过：' + skipped.leaf.title, 'color:#8993A8');
                        setTimeout(() => {
                            this._skipCurrentPending = false;
                            this.nextUnit();
                        }, 300);
                        return;
                    }
                    if (this._isChapterTest()) {
                        this._handleQuizStep();
                        return;
                    }
                    const el = this._getVideoEl();
                    if (hasOpenVideoQuiz()) {
                        // 即使页面一打开就带着弹题，也要先把播放器事件绑定好，
                        // 否则弹题结束、视频播完后不会触发 ended，导致不切换下一节。
                        if (el) this._videoEventHandle();
                        console.log('%c检测到视频弹题，等待自动作答…', 'color:#FF9800');
                        return;
                    }
                    if (el == null) {
                        if (this._currentStepTitle() === '视频') {
                            throw new Error('视频组件尚未加载完成');
                        }
                        if (this._advanceLearningStep()) {
                            console.log('%c当前不在视频页，已尝试切到下一学习步骤，2秒后重试', 'color:#607D8B');
                            setTimeout(() => {
                                this.play();
                            }, 2000);
                            return;
                        }
                        if (this._isChapterTest()) {
                            this._handleQuizStep();
                            return;
                        }
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        if (this._clickPageNextButton()) {
                            console.log('%c当前小节不是视频，已点击页面“下一节/下一章”继续', 'color:#607D8B');
                            return;
                        }
                        if (this.configs.autoAdvanceNoVideo) {
                            console.warn('%c当前小节未发现视频，按配置切换到下一小节', 'color:#FF9800');
                            this.nextUnit();
                        } else {
                            console.warn('%c当前小节未发现视频或可识别的学习步骤，已安全停止。确认无需完成课件后，可执行 app.nextUnit()。', 'color:#FF9800');
                        }
                        return;
                    }

                    this._isPlaying = true;
                    this._videoEventHandle();
                    el.playbackRate = this.configs.playbackRate;
                    if (this.configs.muteVideo) {
                        el.muted = true;
                        el.defaultMuted = true;
                        el.volume = 0;
                    }

                    try {
                        await el.play();
                        this._tryTimes = 0;
                        console.log('%c视频开始播放，倍速: ' + el.playbackRate + 'x', 'color:#4CAF50');
                        this._startVideoMonitoring();
                    } catch (playError) {
                        console.error('视频播放失败:', playError);
                        this._handlePlayError(playError);
                    }
                } catch (error) {
                    if (this._tryTimes >= this.configs.maxRetries) {
                        console.error('%c视频播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', error);
                        this._clearCheckInterval();
                        return;
                    }
                    this._tryTimes++;
                    console.log('%c播放失败，' + (this.configs.retryInterval / 1000) + '秒后重试 (' + this._tryTimes + '/' + this.configs.maxRetries + ')', 'color:#FF9800');
                    setTimeout(() => {
                        this.play();
                    }, this.configs.retryInterval);
                }
            },
            _handleQuizStep() {
                this._videoEl = null;
                this._isPlaying = false;
                this._clearCheckInterval();
                if (settings.autoAnswerQuiz && typeof this.answerQuiz === 'function') {
                    this.answerQuiz();
                } else {
                    this._skipChapterTest();
                }
            },
            _advanceLearningStep() {
                if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) return true;

                const currentStepTitle = this._currentStepTitle();
                if (currentStepTitle === '章节测验' || currentStepTitle === '视频') return false;

                const clickElement = (el, label) => {
                    if (!el) return false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    console.log('%c尝试点击' + label, 'color:#2196F3');
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return true;
                };

                const videoTab = $('.prev_white:visible').filter((_, el) => {
                    const text = ($(el).text() || '').replace(/\s+/g, '');
                    return text === '2视频' || text === '视频';
                }).get(0);
                if (clickElement(videoTab, '“视频”页签')) return true;
                return false;
            },
            _stepSignature() {
                let cardsFrame = null;
                try {
                    cardsFrame = Array.from(PAGE.document.querySelectorAll('iframe[src*="/knowledge/cards"]'))
                        .find((frame) => visible(frame));
                } catch (error) {
                    cardsFrame = null;
                }
                if (cardsFrame) return cardsFrame.getAttribute('src') || '';
                const prevTitle = PAGE.document.getElementsByClassName('prev_title')[0];
                return prevTitle ? (prevTitle.getAttribute('title') || prevTitle.textContent || '') : '';
            },
            _currentStepTitle() {
                let cardsFrame = null;
                try {
                    cardsFrame = Array.from(PAGE.document.querySelectorAll('iframe[src*="/knowledge/cards"]'))
                        .find((frame) => visible(frame));
                } catch (error) {
                    cardsFrame = null;
                }
                if (cardsFrame) {
                    try {
                        const num = new URL(cardsFrame.getAttribute('src'), PAGE.location.href).searchParams.get('num');
                        if (num === '0') return '视频';
                        if (num === '1') return '章节测验';
                    } catch (error) {
                        // 忽略
                    }
                }
                const prevTitle = PAGE.document.getElementsByClassName('prev_title')[0];
                const text = prevTitle ? clean(prevTitle.getAttribute('title') || prevTitle.textContent) : '';
                return text === '视频' || text === '章节测验' ? text : '';
            },
            _isChapterTest() {
                return this._currentStepTitle() === '章节测验';
            },
            _skipChapterTest() {
                if (this._chapterAdvanceTimes >= 3) {
                    console.error('%c章节测验页面连续跳转失败，已停止以避免页面循环。请手动处理后执行 app.run()。', 'color:#F44336;font-weight:bold');
                    return;
                }
                const nextButton = $('#prevNextFocusNext:visible, #right1:visible, .nextChapter:visible').first().get(0);
                if (!nextButton) {
                    console.warn('%c未找到章节测验的下一步按钮，已停止。', 'color:#FF9800');
                    return;
                }
                this._chapterAdvanceTimes++;
                console.log('%c检测到章节测验，尝试进入下一学习步骤', 'color:#607D8B');
                nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                setTimeout(() => this.play(), 2000);
            },
            _advanceChapterTest() {
                this._handleQuizStep();
            },
            _bindStepNavigation() {
                if (this._stepNavigationBound) return;
                this._stepNavigationBound = true;

                const reenterVideoMode = () => {
                    this._videoEl = null;
                    this._isPlaying = false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    setTimeout(() => {
                        try {
                            this._initCellData();
                        } catch (error) {
                            // 忽略
                        }
                        this.play();
                    }, 1800);
                };

                $(document).off('click.xuexitongPlayerV4', '.prev_white').on('click.xuexitongPlayerV4', '.prev_white', (event) => {
                    const text = ($(event.currentTarget).text() || '').replace(/\s+/g, '');
                    if (text.includes('视频') || text.includes('章节测验')) {
                        console.log('%c检测到步骤切换点击：' + text + '，准备重新识别页面', 'color:#607D8B');
                        reenterVideoMode();
                    }
                });
            },
            _handlePlayError(error) {
                console.error('播放错误详情:', error);
                const video = this._getVideoEl();
                if (!video) return;
                video.play().then(() => {
                    console.log('%c静音播放成功', 'color:#4CAF50');
                    this._tryTimes = 0;
                    this._startVideoMonitoring();
                    if (this._delayedNextUnitTimer) {
                        clearTimeout(this._delayedNextUnitTimer);
                        this._delayedNextUnitTimer = null;
                    }
                }).catch((playError) => {
                    console.error('静音播放也失败:', playError);
                    if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                    this._isPlaying = false;
                    if (this._tryTimes >= this.configs.maxRetries) {
                        console.error('%c静音播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', playError);
                        return;
                    }
                    this._tryTimes++;
                    this._delayedNextUnitTimer = setTimeout(() => {
                        this._delayedNextUnitTimer = null;
                        this.play();
                    }, this.configs.retryInterval);
                });
            },
            _initCellData() {
                const el = this._getTreeContainer();
                const cells = el.children('ul').children('li');
                this._cellData.cells = cells.length;
                let nCellCounts = 0;
                let foundCurrent = false;

                cells.each((i, value) => {
                    const nCells = $(value).find('.posCatalog_select:not(.firstLayer)');
                    nCellCounts += nCells.length;
                    nCells.each((j, element) => {
                        const node = $(element);
                        if (!node.hasClass('posCatalog_active')) return;
                        foundCurrent = true;
                        const titleSpan = node.find('.posCatalog_name')[0];
                        const activeTitle = titleSpan
                            ? clean($(titleSpan).attr('title') || $(titleSpan).text())
                            : '';
                        const recentlyClicked = this._lastTocClickAt && Date.now() - this._lastTocClickAt < 10000;
                        // 平台切换小节后经常不更新 posCatalog_active，刚由脚本点击过时不要
                        // 用它覆盖 currentNCellIndex，否则跨章会退回上一节甚至原地打转。
                        if (recentlyClicked && this._lastTocTitle && activeTitle &&
                            activeTitle !== this._lastTocTitle) {
                            return;
                        }
                        this._cellData.currentCellIndex = i;
                        this._cellData.currentNCellIndex = j;
                        if (activeTitle) this._cellData.currentVideoTitle = activeTitle;
                    });
                });

                this._cellData.nCells = nCellCounts;
                if (!foundCurrent && nCellCounts > 0) {
                    console.warn('%c未找到当前激活的视频节点，可能需要手动选择', 'color:#FF9800');
                }
                console.log('%c课程信息: ' + this._cellData.cells + '章, ' + this._cellData.nCells + '节, 当前: 第' + (this._cellData.currentCellIndex + 1) + '章第' + (this._cellData.currentNCellIndex + 1) + '节', 'color:#607D8B');
            },
            _getTreeContainer() {
                // 不再永久缓存：平台切换大章时可能替换整个目录 DOM，
                // 缓存旧节点会导致后续点击落在已经脱离文档的节点上。
                const el = $('#coursetree');
                if (el.length <= 0) throw new Error('找不到视频列表');
                this._treeContainerEl = el;
                return el;
            },
            _getVideoEl() {
                if (!this._videoEl) {
                    try {
                        const findVideo = (frame, depth) => {
                            if (depth > 2) return null;
                            let frameDocument = null;
                            try {
                                frameDocument = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
                            } catch (error) {
                                frameDocument = null;
                            }
                            if (!frameDocument) return null;
                            const direct = frameDocument.querySelector('video#video_html5_api, video[id*="video_html5"]');
                            if (direct) return direct;
                            const nestedFrames = frameDocument.querySelectorAll('iframe.ans-insertvideo-online, iframe[src*="video"]');
                            for (const nestedFrame of nestedFrames) {
                                const found = findVideo(nestedFrame, depth + 1);
                                if (found) return found;
                            }
                            return null;
                        };

                        for (const frame of PAGE.document.querySelectorAll('iframe')) {
                            const video = findVideo(frame, 0);
                            if (video) {
                                this._videoEl = video;
                                if (this.configs.muteVideo) {
                                    video.muted = true;
                                    video.defaultMuted = true;
                                    video.volume = 0;
                                }
                                break;
                            }
                        }
                    } catch (error) {
                        console.error('获取视频元素失败:', error);
                        return null;
                    }
                }
                return this._videoEl || null;
            },
            _videoEventHandle() {
                const el = this._videoEl;
                if (!el) {
                    console.log('videoEl未加载');
                    return;
                }
                if (this._eventVideoEl === el) return;
                this._detachVideoEvents();
                this._eventVideoEl = el;
                this._boundVideoHandlers = {
                    ended: this._handleVideoEnded.bind(this),
                    loadedmetadata: this._handleVideoLoaded.bind(this),
                    play: this._handleVideoPlay.bind(this),
                    pause: this._handleVideoPause.bind(this),
                };
                el.addEventListener('ended', this._boundVideoHandlers.ended);
                el.addEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                el.addEventListener('play', this._boundVideoHandlers.play);
                el.addEventListener('pause', this._boundVideoHandlers.pause);
            },
            _detachVideoEvents() {
                if (!this._eventVideoEl || !this._boundVideoHandlers) return;
                this._eventVideoEl.removeEventListener('ended', this._boundVideoHandlers.ended);
                this._eventVideoEl.removeEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                this._eventVideoEl.removeEventListener('play', this._boundVideoHandlers.play);
                this._eventVideoEl.removeEventListener('pause', this._boundVideoHandlers.pause);
                this._eventVideoEl = null;
                this._boundVideoHandlers = null;
            },
            _handleVideoEnded() {
                const title = this._cellData.currentVideoTitle;
                console.warn('%c============\'' + title + '\' 播放完成=============', 'color:#4CAF50;font-weight:bold');
                if (hasOpenVideoQuiz()) {
                    console.warn('%c视频已结束，但视频弹题仍在处理中，暂不切换下一节', 'color:#FF9800');
                    this._isPlaying = false;
                    return;
                }
                this._isPlaying = false;
                this._clearCheckInterval();
                setTimeout(() => this.nextUnit(), 1000);
            },
            _handleVideoLoaded() {
                console.log('%c============视频加载完成=============', 'color:#2196F3');
                if (this.configs.autoplay && !this._isPlaying) this.play();
            },
            _handleVideoPlay() {
                const title = this._cellData.currentVideoTitle;
                console.info('%c============\'' + title + '\' 开始播放=============', 'color:#4CAF50');
                this._isPlaying = true;
                this._stepSwitchPending = false;
                const video = this._getVideoEl();
                this._guardLastTime = Number(video && video.currentTime || 0);
                this._guardLastWallTs = Date.now();
                if (this._delayedNextUnitTimer) {
                    clearTimeout(this._delayedNextUnitTimer);
                    this._delayedNextUnitTimer = null;
                }
            },
            _handleVideoPause() {
                console.log('%c============视频暂停=============', 'color:#FF9800');
            },
            _bindPageGuards() {
                const preventPause = (event) => {
                    event.stopPropagation();
                    event.preventDefault();
                };
                const resumePlaybackNow = () => this._tryResumePlayback('page-event');
                this._pageGuards = { preventPause, resumePlaybackNow };
                PAGE.document.addEventListener('mouseleave', preventPause);
                PAGE.addEventListener('mouseleave', preventPause);
                PAGE.document.addEventListener('mouseout', preventPause);
                PAGE.addEventListener('mouseout', preventPause);
                PAGE.addEventListener('blur', resumePlaybackNow);
                PAGE.document.addEventListener('visibilitychange', resumePlaybackNow);
            },
            destroy() {
                if (this._destroyed) return;
                this._destroyed = true;
                this._isPlaying = false;
                this._clearCheckInterval();
                this._detachVideoEvents();
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                try {
                    $(document).off('.xuexitongPlayerV4');
                } catch (error) {
                    // 忽略
                }
                if (this._pageGuards) {
                    const guards = this._pageGuards;
                    PAGE.document.removeEventListener('mouseleave', guards.preventPause);
                    PAGE.removeEventListener('mouseleave', guards.preventPause);
                    PAGE.document.removeEventListener('mouseout', guards.preventPause);
                    PAGE.removeEventListener('mouseout', guards.preventPause);
                    PAGE.removeEventListener('blur', guards.resumePlaybackNow);
                    PAGE.document.removeEventListener('visibilitychange', guards.resumePlaybackNow);
                    this._pageGuards = null;
                }
            },
        };

        attachQuizAutomation(app);
        createControlPanel(app);
        applySettings(app);
        PAGE.app = app;
        PAGE[APP_KEY] = app;

        try {
            app.run();
            app._bindPageGuards();
        } catch (error) {
            console.error('%c脚本运行失败: ', 'color:#F44336;font-weight:bold', error.message);
            console.log('请检查是否在正确的课程播放页面，或者页面结构是否再次发生改变。');
        }
    }

    // ============================================================
    // 启动
    // ============================================================

    function waitForCoursePage() {
        let attempts = 0;
        const maxAttempts = 20;
        PAGE[BOOT_TIMER_KEY] = setInterval(() => {
            if ($('#coursetree').length > 0) {
                clearInterval(PAGE[BOOT_TIMER_KEY]);
                PAGE[BOOT_TIMER_KEY] = null;
                initializePlayer();
                return;
            }
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(PAGE[BOOT_TIMER_KEY]);
                PAGE[BOOT_TIMER_KEY] = null;
                console.error('%c脚本启动超时：未检测到课程目录（#coursetree）。请确认当前处于课程播放页。', 'color:#F44336;font-weight:bold');
            }
        }, 1000);
    }

    function boot() {
        for (const key of LEGACY_APP_KEYS) {
            const old = PAGE[key];
            if (old && typeof old.destroy === 'function') {
                try {
                    old.destroy();
                } catch (error) {
                    // 忽略
                }
            }
        }
        const previousApp = PAGE[APP_KEY];
        if (previousApp && typeof previousApp.destroy === 'function') {
            try {
                previousApp.destroy();
            } catch (error) {
                // 忽略
            }
        }
        if (PAGE[BOOT_TIMER_KEY]) {
            clearInterval(PAGE[BOOT_TIMER_KEY]);
            PAGE[BOOT_TIMER_KEY] = null;
        }

        if (typeof PAGE.jQuery === 'undefined') {
            const script = document.createElement('script');
            script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
            script.type = 'text/javascript';
            script.onload = function () {
                console.log('jQuery loaded.');
                if (typeof PAGE.jQuery === 'undefined') {
                    console.error('jQuery 加载后仍不可用，脚本无法启动');
                    return;
                }
                waitForCoursePage();
            };
            script.onerror = function () {
                console.error('jQuery 加载失败，脚本无法启动');
            };
            document.head.appendChild(script);
        } else {
            waitForCoursePage();
        }
    }

    boot();
})();
