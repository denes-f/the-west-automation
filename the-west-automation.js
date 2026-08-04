// ==UserScript==
// @name         The-West Modular Job Queue (Lisa v10.23 - Élő sorállapot)
// @namespace   http://tampermonkey.net/
// @version     10.23
// @description XHR‑alapú munkaindítás, maradék automatikus sorba, mennyiség max 99, fallback, auto-close dialógus, menü gomb.
// @author      Lisa
// @include     https://*.the-west.hu/*
// @grant       none
// @run-at      document-end
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    //  1. BEÁLLÍTÁSOK
    // ============================================================
    const CONFIG = {
        JOB_ADD_ENDPOINT: 'window=task&action=add',
        SAFETY_MARGIN_MS: 3000,
        FULL_QUEUE_POLL_MIN: 15000,
        FULL_QUEUE_POLL_MAX: 25000,
        ERROR_RETRY_BASE: 20000,     // exponenciális backoff kiindulópontja
        ERROR_RETRY_MAX: 300000,     // egy újrapróba sem vár ennél többet
        MAX_RETRIES: 5,              // ennyi hiba után a munka a sor végére kerül
        MAX_DEFERRALS: 2,            // ennyi sikertelen kör után eldobjuk
        REQUEST_TIMEOUT: 20000,
        IDLE_RESCHEDULE: 5000,       // vészfék: ha egy ág elfelejtene időzítőt állítani
        STORAGE_EXTRA_QUEUE: 'lisa_extra_params_v1020',
        STORAGE_HISTORY: 'lisa_modular_history_v97',
        STORAGE_GAME_QUEUE: 'lisa_game_queue_v1',
        TASK_WINDOW_MATCH: 'window=task',
        MIN_SEND_GAP: 2000,          // két egymást követő küldés között
        MAX_WAIT_MS: 3600000,        // egy hibás date_done se tudja örökre megállítani
        PANEL_WIDTH: 320,
        BUTTON_COOLDOWN: 1500,
        MAX_AMOUNT: 99,
        MIN_AMOUNT: 1,
        FALLBACK_TIMEOUT: 1500,
        QUEUE_SIZE: 4,               // a játék saját munkasorának mérete
        DEFAULT_DURATION: 900,       // csak ha se a DOM-ból, se az előzményekből nem derül ki
        MAX_EXTRA_QUEUE: 500,
    };

    // ============================================================
    //  2. BELSŐ ÁLLAPOTOK
    // ============================================================
    let extraJobs = [];
    let jobHistory = [];
    let paused = false;
    let cachedHash = null;
    let pendingJobName = null;
    let pendingJobAmount = 0;
    let pendingQueueLengthBefore = 0;
    let processing = false;
    let nextJobTimer = null;

    // A játék saját munkasorának modellje: [{ dateDone, jobId }], szerver-epoch
    // másodpercben. Minden task-ablak válaszból újraszinkronizáljuk, és az
    // óra alapján magától fogy -- így nem áll el a valóságtól, és túléli az F5-öt.
    let gameQueue = [];
    let serverClockOffsetMs = 0;

    let pendingFallback = null;
    let jobRequestSent = false;

    let uiPanel, uiExtraList, uiHistoryList, uiStatus, uiExtraCount, uiHistoryCount;
    let uiHashStatus;
    let addingFromHistory = false;
    let addButton = null;
    let showButton = null; // a menüsorban lévő gomb

    const OriginalXHR = window.XMLHttpRequest;

    // ============================================================
    //  3. SEGÉDFÜGGVÉNYEK
    // ============================================================
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 6);

    function parseBodyParams(body) {
        try {
            if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body));
            if (body instanceof FormData) {
                const out = {};
                for (const [k, v] of body.entries()) out[k] = v;
                return out;
            }
            if (body && typeof body === 'object') return body;
        } catch(e) {}
        return {};
    }

    // tasks[N][jobId] & társai -> normalizált munkaobjektum, vagy null.
    function extractTaskFromBody(body) {
        const params = parseBodyParams(body);
        let jobId = null, x = null, y = null, duration = null, taskType = 'job';
        for (const k in params) {
            if (k.endsWith('[jobId]')) jobId = params[k];
            else if (k.endsWith('[x]')) x = params[k];
            else if (k.endsWith('[y]')) y = params[k];
            else if (k.endsWith('[duration]')) duration = params[k];
            else if (k.endsWith('[taskType]')) taskType = params[k];
        }
        if (jobId === null) return null;
        return {
            jobId: parseInt(jobId, 10),
            x: parseInt(x, 10) || 0,
            y: parseInt(y, 10) || 0,
            duration: parseInt(duration, 10) || CONFIG.DEFAULT_DURATION,
            taskType: taskType || 'job',
        };
    }

    function extractJobName(body) {
        const task = extractTaskFromBody(body);
        return task ? `Job #${task.jobId}` : 'Ismeretlen';
    }

    function extractHashFromURL(url) {
        const match = url.match(/[?&]h=([a-f0-9]{6,})/i);
        return match ? match[1] : null;
    }

    function shuffleHeaders(headers) {
        const entries = Object.entries(headers);
        for (let i = entries.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [entries[i], entries[j]] = [entries[j], entries[i]];
        }
        return Object.fromEntries(entries);
    }

    function updateUIStatus(text) {
        if (uiStatus) uiStatus.textContent = text;
    }

    function updateHashStatus() {
        if (uiHashStatus) {
            uiHashStatus.textContent = cachedHash ? `Hash: ${cachedHash}` : 'Hash: nincs';
            uiHashStatus.style.color = cachedHash ? '#c8a96e' : '#a04040';
        }
    }

    function sendXHR(url, method, body, headers) {
        return new Promise((resolve, reject) => {
            const xhr = new OriginalXHR();
            xhr.open(method, url, true);
            xhr.timeout = CONFIG.REQUEST_TIMEOUT;
            if (headers) {
                Object.keys(headers).forEach(key => xhr.setRequestHeader(key, headers[key]));
            }
            xhr.onload = () => {
                try { noteServerDate(xhr.getResponseHeader('Date')); } catch(e) {}
                resolve({ status: xhr.status, responseText: xhr.responseText });
            };
            xhr.onerror = () => reject(new Error('Hálózati hiba'));
            xhr.ontimeout = () => reject(new Error('Időtúllépés'));
            xhr.onabort = () => reject(new Error('Megszakított kérés'));
            xhr.send(body);
        });
    }

    function findKeyInObject(obj, key) {
        if (typeof obj !== 'object' || obj === null) return null;
        if (obj.hasOwnProperty(key)) return obj[key];
        for (const k in obj) {
            if (typeof obj[k] === 'object') {
                const result = findKeyInObject(obj[k], key);
                if (result !== null) return result;
            }
        }
        return null;
    }

    // ============================================================
    //  4. A JÁTÉK MUNKASORÁNAK MODELLJE
    // ============================================================
    // A date_done szerveridő, a Date.now() kliensidő. Az eltérést a válaszok
    // Date fejlécéből tanuljuk, különben egy elállított óra minden ütemezést eltol.
    function serverNow() { return Date.now() + serverClockOffsetMs; }

    function noteServerDate(dateHeader) {
        if (!dateHeader) return;
        const t = Date.parse(dateHeader);
        if (isNaN(t)) return;
        const offset = t - Date.now();
        if (Math.abs(offset - serverClockOffsetMs) > 5000) {
            console.log(`[Lisa] Szerver-kliens óraeltérés: ${Math.round(offset / 1000)} mp`);
        }
        serverClockOffsetMs = offset;
    }

    // A lejárt munkák maguktól kikerülnek a modellből: ez váltja ki azt, hogy
    // korábban a számláló csak nőtt, sosem csökkent.
    function pruneGameQueue() {
        const nowSec = serverNow() / 1000;
        const before = gameQueue.length;
        gameQueue = gameQueue.filter(t => t.dateDone > nowSec);
        if (gameQueue.length !== before) {
            saveGameQueueToStorage();
            console.log(`[Lisa] ${before - gameQueue.length} munka befejeződött (sor: ${gameQueue.length}/${CONFIG.QUEUE_SIZE})`);
        }
        return gameQueue;
    }

    function getQueueLength() { return pruneGameQueue().length; }
    function isQueueFull() { return getQueueLength() >= CONFIG.QUEUE_SIZE; }

    // A következő szabad slot ideje = a legkorábban befejeződő munka.
    // Korábban a findKeyInObject az első megtalált date_done-t adta vissza,
    // ami kulcssorrendtől függött, nem feltétlenül a legkorábbi volt.
    function getNextFreeAt() {
        const times = pruneGameQueue().map(t => t.dateDone).filter(t => t > 0);
        return times.length ? Math.min(...times) : null;
    }

    function waitUntilFreeSlotMs() {
        const freeAt = getNextFreeAt();
        if (!freeAt) return rand(CONFIG.FULL_QUEUE_POLL_MIN, CONFIG.FULL_QUEUE_POLL_MAX);
        const wait = Math.max(0, freeAt * 1000 - serverNow()) + CONFIG.SAFETY_MARGIN_MS;
        return Math.min(wait, CONFIG.MAX_WAIT_MS);
    }

    // A szerver által küldött tasklista mindig felülírja a helyi becslést.
    function syncGameQueueFromResponse(resp) {
        if (!resp || !resp.tasks || typeof resp.tasks !== 'object') return false;
        const list = Array.isArray(resp.tasks) ? resp.tasks : Object.values(resp.tasks);
        const nowSec = serverNow() / 1000;

        gameQueue = list.filter(t => t && typeof t === 'object').map(t => {
            const raw = parseFloat(t.date_done);
            return {
                dateDone: (!isNaN(raw) && raw > 0) ? raw : nowSec + CONFIG.DEFAULT_DURATION,
                jobId: t.jobId || t.job_id || null,
            };
        });
        if (gameQueue.length > CONFIG.QUEUE_SIZE) CONFIG.QUEUE_SIZE = gameQueue.length;
        saveGameQueueToStorage();
        console.log(`[Lisa] Sor szinkronizálva a szerverről: ${gameQueue.length}/${CONFIG.QUEUE_SIZE}`);
        return true;
    }

    // Ha a válasz nem tartalmazott tasklistát, becslünk: a munka a sor végén fut le.
    function noteQueuedLocally(job, dateDone) {
        const nowSec = serverNow() / 1000;
        const lastDone = gameQueue.reduce((max, t) => Math.max(max, t.dateDone), nowSec);
        gameQueue.push({
            dateDone: (dateDone && dateDone > 0) ? dateDone : lastDone + (job.duration || CONFIG.DEFAULT_DURATION),
            jobId: job.jobId,
        });
        saveGameQueueToStorage();
    }

    function saveGameQueueToStorage() {
        try { localStorage.setItem(CONFIG.STORAGE_GAME_QUEUE, JSON.stringify(gameQueue)); } catch(e) {}
    }

    function loadGameQueueFromStorage() {
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_GAME_QUEUE);
            const parsed = raw ? JSON.parse(raw) : null;
            if (Array.isArray(parsed)) {
                gameQueue = parsed.filter(t => t && typeof t.dateDone === 'number');
            }
        } catch(e) { gameQueue = []; }
        // A dateDone abszolút szerveridő, ezért újratöltés után is értelmezhető:
        // az F5 óta befejeződött munkák itt esnek ki.
        pruneGameQueue();
    }

    // ============================================================
    //  5. MENNYISÉGVÁLASZTÓ FELOLDÁSA
    // ============================================================
    function initAmountPatch() {
        document.addEventListener('click', function(e) {
            const plusBtn = e.target.closest('.job-amount-plus');
            if (plusBtn) {
                e.stopImmediatePropagation();
                e.preventDefault();
                const amountNum = plusBtn.parentElement.querySelector('.job-amount-num');
                if (amountNum) {
                    let current = parseInt(amountNum.textContent, 10) || CONFIG.MIN_AMOUNT;
                    if (current < CONFIG.MAX_AMOUNT) {
                        amountNum.textContent = current + 1;
                    }
                }
                return;
            }
            const minusBtn = e.target.closest('.job-amount-minus');
            if (minusBtn) {
                e.stopImmediatePropagation();
                e.preventDefault();
                const amountNum = minusBtn.parentElement.querySelector('.job-amount-num');
                if (amountNum) {
                    let current = parseInt(amountNum.textContent, 10) || CONFIG.MIN_AMOUNT;
                    if (current > CONFIG.MIN_AMOUNT) {
                        amountNum.textContent = current - 1;
                    }
                }
            }
        }, true);
        console.log('[Lisa] Mennyiségválasztó feloldva.');
    }

    // ============================================================
    //  5. "TÖBB MUNKA?" DIALÓGUS AUTOMATIKUS BEZÁRÁSA
    // ============================================================
    function closeMoreJobsDialog() {
        const dialogs = document.querySelectorAll('.tw2gui_dialog');
        for (const dlg of dialogs) {
            const title = dlg.querySelector('.textart_title');
            if (title && title.textContent.trim() === 'Több munka?') {
                const buttons = dlg.querySelectorAll('.tw2gui_button');
                for (const btn of buttons) {
                    if (btn.textContent.trim() === 'Mégse') {
                        btn.click();
                        console.log('[Lisa] "Több munka?" dialógus bezárva.');
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function scheduleDialogClose() {
        let attempts = 0;
        const maxAttempts = 10;
        const interval = setInterval(() => {
            if (closeMoreJobsDialog() || attempts >= maxAttempts) {
                clearInterval(interval);
            }
            attempts++;
        }, 200);
    }

    // ============================================================
    //  6. JOB ADATOK KINYERÉSE (FALLBACKHEZ)
    // ============================================================
    // "45 mp", "15 p", "1 ó", "1 ó 30 p" -> másodperc. Összetett alakot is kezel,
    // és az órát is: enélkül minden hosszú munka 15 percnek látszott.
    function parseDurationText(text) {
        if (!text) return null;
        const t = text.trim().toLowerCase();
        let total = 0, matched = false;

        const hours = t.match(/(\d+)\s*(?:óra|ó|h)/);
        if (hours) { total += parseInt(hours[1], 10) * 3600; matched = true; }

        const seconds = t.match(/(\d+)\s*(?:mp|sec|s)\b/);
        if (seconds) { total += parseInt(seconds[1], 10); matched = true; }

        // A perceket csak az "mp" eltávolítása után keressük, különben az "mp" is 'p'-re végződik.
        const minutes = t.replace(/\d+\s*mp/g, '').match(/(\d+)\s*(?:perc|min|p|m)\b/);
        if (minutes) { total += parseInt(minutes[1], 10) * 60; matched = true; }

        return matched && total > 0 ? total : null;
    }

    function parseJobWindow(windowEl) {
        const classList = windowEl.className;
        const match = classList.match(/job-(\d+)-(\d+)-(\d+)/);
        if (!match) return null;
        const x = parseInt(match[1], 10);
        const y = parseInt(match[2], 10);
        const jobId = parseInt(match[3], 10);

        const activeBar = windowEl.querySelector('.job_durationbar:not(.disabled)');
        const durationEl = activeBar ? activeBar.querySelector('.job_value_duration') : null;
        let duration = durationEl ? parseDurationText(durationEl.textContent) : null;

        if (!duration) {
            // A szerver által korábban visszaigazolt érték megbízhatóbb, mint egy vak default.
            const known = jobHistory.find(j => j.jobId === jobId);
            duration = known ? known.duration : CONFIG.DEFAULT_DURATION;
            console.warn(`[Lisa] Időtartam nem olvasható ki (job #${jobId}), használt érték: ${duration}s`);
        }
        return { jobId, x, y, duration, taskType: 'job' };
    }

    // ============================================================
    //  7. FALLBACK LOGIKA
    // ============================================================
    function clearFallback() {
        if (pendingFallback) {
            clearTimeout(pendingFallback.timer);
            pendingFallback = null;
        }
        jobRequestSent = false;
    }

    function handleFallback() {
        if (!pendingFallback) return;
        if (jobRequestSent) {
            clearFallback();
            return;
        }
        const { amount, jobId, x, y, duration, taskType, jobName } = pendingFallback;
        console.log(`[Lisa Fallback] Sor tele, a játék nem küldött kérést. ${amount} munka az extra sorba.`);
        const added = addExtraJobs({ jobId, x, y, duration, taskType }, amount, jobName);
        updateUI();
        updateUIStatus(`${added} munka az extra sorba helyezve (fallback).`);
        ensureProcessing();
        clearFallback();
    }

    // ============================================================
    //  8. XHR INTERCEPTOR
    // ============================================================
    document.addEventListener('click', function(e) {
        const startBtn = e.target.closest('.job_startbutton');
        if (!startBtn) return;
        const jobWindow = startBtn.closest('.tw2gui_window');
        if (!jobWindow) return;

        const titleElem = jobWindow.querySelector('.textart_title');
        const jobName = titleElem ? titleElem.textContent.trim() : null;

        const amountElem = jobWindow.querySelector('.job-amount-num');
        const amount = amountElem ? (parseInt(amountElem.textContent.trim(), 10) || 1) : 1;

        // Ha az extra sorban már várakozik munka, a játékot NEM engedjük elküldeni
        // a kérést. Különben a szabad játékslotokba az új munkák kerülnének, azaz
        // beelőznének a régebben sorbaállítottak elé. Így a sorrend mindig FIFO.
        const takeoverData = extraJobs.length > 0 ? parseJobWindow(jobWindow) : null;
        if (takeoverData) {
            e.stopImmediatePropagation();
            e.preventDefault();
            clearFallback();
            const name = jobName || `Job #${takeoverData.jobId}`;
            const added = addExtraJobs(takeoverData, amount, name);
            addJobToHistory({ ...takeoverData, jobName: name });
            updateUI();
            updateUIStatus(`${added} munka az extra sor végére (${extraJobs.length} várakozik).`);
            ensureProcessing();
            return;
        }
        if (extraJobs.length > 0) {
            console.warn('[Lisa] Extra sor nem üres, de a munka adatai nem olvashatók ki – a játék kezeli a kattintást.');
        }

        // Innentől a játék küldi a kérést, mi csak a maradékot kapjuk el.
        scheduleDialogClose();
        pendingJobName = jobName;
        pendingJobAmount = amount;
        pendingQueueLengthBefore = getQueueLength();
        console.log(`[Lisa] Munka: ${pendingJobName}, mennyiség: ${pendingJobAmount}, sor előtte: ${pendingQueueLengthBefore}`);

        clearFallback();
        if (isQueueFull()) {
            const jobData = parseJobWindow(jobWindow);
            if (jobData) {
                pendingFallback = {
                    amount: pendingJobAmount,
                    ...jobData,
                    jobName: pendingJobName || `Job #${jobData.jobId}`,
                    timer: setTimeout(handleFallback, CONFIG.FALLBACK_TIMEOUT)
                };
                console.log('[Lisa] Fallback előkészítve (sor tele).');
            }
        } else {
            console.log('[Lisa] Sor nincs tele, fallback nem szükséges.');
        }
    }, true);

    window.XMLHttpRequest = function() {
        const xhr = new OriginalXHR();
        const origOpen = xhr.open;
        const origSend = xhr.send;
        let reqUrl = '', reqMethod = '', reqBody = null;

        xhr.open = function(method, url, ...rest) {
            reqMethod = method.toUpperCase();
            reqUrl = url;
            return origOpen.apply(this, [method, url, ...rest]);
        };

        xhr.send = function(body) {
            reqBody = body;
            if (reqMethod === 'POST' && reqUrl.includes(CONFIG.JOB_ADD_ENDPOINT)) {
                // A fallbacknak azt kell tudnia, hogy a játék ELINDÍTOTTA a kérést.
                // Ha csak a válasz beérkezésekor jeleznénk, egy a FALLBACK_TIMEOUT-nál
                // lassabb válasz esetén a fallback is és a játék is hozzáadná a munkákat.
                jobRequestSent = true;
            }
            xhr.addEventListener('load', function() {
                if (reqMethod !== 'POST') return;

                try { noteServerDate(xhr.getResponseHeader('Date')); } catch(e) {}

                const h = extractHashFromURL(reqUrl);
                if (h) {
                    if (!cachedHash || cachedHash !== h) {
                        cachedHash = h;
                        console.log('[Lisa] Hash frissítve:', cachedHash);
                        updateHashStatus();
                        updateUIStatus('Hash megszerezve.');
                    }
                }

                if (!reqUrl.includes(CONFIG.TASK_WINDOW_MATCH)) return;

                // Bármelyik task-ablak válasza hozhat friss tasklistát: indítás,
                // megszakítás, ablaknyitás. Mind hiteles forrás, mind szinkronizál.
                const verdict = classifyAddResponse(xhr.status, xhr.responseText);
                const queueLengthBefore = pendingQueueLengthBefore;
                const synced = syncGameQueueFromResponse(verdict.resp);
                const queueLengthAfter = synced ? gameQueue.length : null;

                if (reqUrl.includes(CONFIG.JOB_ADD_ENDPOINT)) {
                    clearFallback();

                    const task = extractTaskFromBody(reqBody);
                    const jobName = pendingJobName || (task ? `Job #${task.jobId}` : 'Ismeretlen');

                    if (task && (verdict.outcome === 'success' || verdict.outcome === 'queue_full')) {
                        addJobToHistory({ ...task, jobName });
                        console.log('[Lisa] Munka rögzítve:', jobName);
                    }

                    if (task && pendingJobAmount > 0) {
                        // resp.tasks a sor TELJES tartalma az indítás után, nem a most
                        // hozzáadottak száma -- a kettő csak üres sorra indítva egyezik.
                        // A különbségből számolunk, különben részben tele sorra indítva
                        // némán elveszne a köteg egy része.
                        let added;
                        if (verdict.outcome !== 'success') {
                            added = 0; // a szerver elutasította: a teljes köteg a miénk
                        } else if (queueLengthAfter !== null) {
                            added = Math.max(0, queueLengthAfter - queueLengthBefore);
                        } else {
                            added = Math.min(pendingJobAmount, Math.max(0, CONFIG.QUEUE_SIZE - queueLengthBefore));
                        }
                        const remaining = Math.max(0, pendingJobAmount - added);
                        console.log(`[Lisa] Manuális: kért ${pendingJobAmount}, sor ${queueLengthBefore} -> ${queueLengthAfter}, hozzáadva ${added}, maradék ${remaining}`);

                        if (remaining > 0) {
                            const queued = addExtraJobs(task, remaining, jobName);
                            updateUI();
                            updateUIStatus(verdict.outcome === 'success'
                                ? `${queued} maradék munka az extra sorba helyezve.`
                                : `${queued} munka az extra sorba (szerver: ${verdict.reason}).`);
                            ensureProcessing();
                        }
                    }

                    pendingJobName = null;
                    pendingJobAmount = 0;
                    pendingQueueLengthBefore = 0;
                }
            });
            origSend.apply(this, arguments);
        };
        return xhr;
    };

    function addJobToHistory(jobData) {
        const existingIndex = jobHistory.findIndex(j =>
            j.jobId === jobData.jobId && j.duration === jobData.duration && j.x === jobData.x && j.y === jobData.y
        );
        if (existingIndex !== -1) {
            const storedName = jobHistory[existingIndex].jobName;
            if (storedName.startsWith('Job #') && !jobData.jobName.startsWith('Job #')) {
                jobHistory[existingIndex].jobName = jobData.jobName;
                jobHistory[existingIndex].timestamp = Date.now();
                jobHistory.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                saveHistoryToStorage();
                if (uiHistoryList) updateUI();
            }
            return;
        }
        jobHistory.unshift({
            id: generateId(),
            jobId: jobData.jobId,
            x: jobData.x,
            y: jobData.y,
            duration: jobData.duration,
            taskType: jobData.taskType || 'job',
            jobName: jobData.jobName || extractJobName(jobData.body),
            timestamp: Date.now(),
        });
        saveHistoryToStorage();
        if (uiHistoryList) updateUI();
    }

    // ============================================================
    //  9. EXTRA SOR KEZELÉSE
    // ============================================================
    // Kötegelt hozzáadás: egyetlen localStorage írás N helyett. 99 munka
    // hozzáadása korábban 99 szinkron stringify+write ciklust jelentett.
    function addExtraJobs(params, count, displayName) {
        const wanted = Math.max(0, Math.min(parseInt(count, 10) || 0, CONFIG.MAX_AMOUNT));
        const room = Math.max(0, CONFIG.MAX_EXTRA_QUEUE - extraJobs.length);
        const n = Math.min(wanted, room);
        const name = displayName || `Job #${params.jobId}`;

        for (let i = 0; i < n; i++) {
            extraJobs.push({
                id: generateId(),
                retries: 0,
                deferrals: 0,
                jobName: name,
                jobId: params.jobId,
                x: params.x,
                y: params.y,
                duration: params.duration,
                taskType: params.taskType || 'job',
            });
        }
        saveExtraQueueToStorage();

        if (n < wanted) {
            console.warn(`[Lisa] Extra sor megtelt (${CONFIG.MAX_EXTRA_QUEUE}), ${wanted - n} munka nem fért be.`);
        }
        if (n > 0) console.log(`[Lisa] Extra sorba: ${n}x ${name} (ID:${params.jobId}) (összesen ${extraJobs.length})`);
        return n;
    }

    function addExtraJob(params, displayName = null, updateUIAfter = false) {
        addExtraJobs(params, 1, displayName);
        if (updateUIAfter && uiExtraList) updateUI();
    }

    // ============================================================
    //  10. VÁLASZ KIÉRTÉKELÉS
    // ============================================================
    // Minden lehetséges válasz pontosan egy kimenetet kap: 'success', 'queue_full'
    // vagy 'retry'. Nincs átesés: munka soha nem tűnhet el szó nélkül.
    function classifyAddResponse(status, responseText) {
        if (status === 0) return { outcome: 'retry', reason: 'Nincs válasz (hálózat?)' };
        if (status === 401 || status === 403) {
            return { outcome: 'retry', reason: `Munkamenet lejárt (HTTP ${status})`, invalidateHash: true };
        }
        if (status >= 400) return { outcome: 'retry', reason: `HTTP ${status}` };

        let resp = null;
        try { resp = JSON.parse(responseText); } catch(e) {}

        if (resp === null || typeof resp !== 'object') {
            // Régi, nem JSON válaszformátum – ha van benne date_done, sikeres.
            if (/date_done/i.test(responseText)) {
                const m = responseText.match(/"date_done":\s*(\d+\.?\d*)/i);
                return { outcome: 'success', dateDone: m ? parseFloat(m[1]) : null };
            }
            // Kijelentkezés, karbantartás, hibaoldal: HTML jön JSON helyett.
            if (/<html|<!doctype|<body/i.test(responseText)) {
                return { outcome: 'retry', reason: 'HTML válasz (kijelentkezés / karbantartás?)', invalidateHash: true };
            }
            return { outcome: 'retry', reason: 'Értelmezhetetlen válasz' };
        }

        if (resp.error) {
            const msg = (typeof resp.error === 'string' && resp.error) || resp.msg || 'Ismeretlen szerverhiba';
            if (/megtelt|tele van|queue full|task limit|too many tasks/i.test(msg)) {
                return { outcome: 'queue_full', reason: msg, resp };
            }
            if (/hash|session|munkamenet|bejelentkez/i.test(msg)) {
                return { outcome: 'retry', reason: msg, invalidateHash: true, resp };
            }
            return { outcome: 'retry', reason: msg, resp };
        }

        const dateDone = findKeyInObject(resp, 'date_done');
        if (dateDone || resp.tasks || resp.msg) {
            return { outcome: 'success', dateDone: dateDone || null, resp };
        }
        return { outcome: 'retry', reason: 'Ismeretlen válaszformátum', resp };
    }

    function requeueJob(job, toBack) {
        if (toBack) extraJobs.push(job);
        else extraJobs.unshift(job);
        saveExtraQueueToStorage();
        updateExtraList();
    }

    function retryDelayFor(job) {
        const base = Math.min(CONFIG.ERROR_RETRY_BASE * Math.pow(2, Math.max(0, job.retries - 1)), CONFIG.ERROR_RETRY_MAX);
        return rand(base, base + Math.round(base * 0.3));
    }

    // Egyetlen belépési pont a küldés utáni állapotkezelésre. Minden ága
    // vagy ütemez egy következő próbát, vagy tudatosan eldobja a munkát.
    function applyVerdict(job, verdict) {
        if (verdict.invalidateHash && cachedHash) {
            console.warn('[Lisa] Hash érvénytelenítve:', verdict.reason);
            cachedHash = null;
            updateHashStatus();
        }

        if (verdict.outcome === 'success') {
            job.retries = 0;
            console.log(`[Lisa] Sikeresen elküldve: ${job.jobName}`);
            if (!syncGameQueueFromResponse(verdict.resp)) noteQueuedLocally(job, verdict.dateDone);

            // Ha maradt szabad slot, nincs értelme a befejezésre várni -- korábban
            // a script akkor is végigvárta a date_done-t, ha üresen állt a sor fele.
            if (!isQueueFull()) {
                updateUIStatus(`Elküldve: ${job.jobName} (sor: ${getQueueLength()}/${CONFIG.QUEUE_SIZE}, még ${extraJobs.length})`);
                scheduleNextJob(rand(CONFIG.MIN_SEND_GAP, CONFIG.MIN_SEND_GAP + 2000));
            } else {
                const waitMs = waitUntilFreeSlotMs();
                updateUIStatus(`Sor tele – következő slot ~${Math.round(waitMs / 1000)} mp múlva`);
                scheduleNextJob(waitMs);
            }
            return;
        }

        if (verdict.outcome === 'queue_full') {
            // Várható állapot, nem hiba: nem számít bele az újrapróbálkozásokba.
            // Ha a szerver küldött tasklistát, abból tudjuk, mikor szabadul fel slot.
            requeueJob(job, false);
            syncGameQueueFromResponse(verdict.resp);
            const waitMs = waitUntilFreeSlotMs();
            updateUIStatus(`Sor tele – várakozás ~${Math.round(waitMs / 1000)} mp`);
            scheduleNextJob(waitMs);
            return;
        }

        job.retries = (job.retries || 0) + 1;
        console.warn(`[Lisa] Sikertelen: ${job.jobName} (${job.retries}. próba) – ${verdict.reason}`);

        if (job.retries <= CONFIG.MAX_RETRIES) {
            requeueJob(job, false);
            const delay = retryDelayFor(job);
            updateUIStatus(`Hiba: ${verdict.reason} – újra ${Math.round(delay / 1000)} mp múlva (${job.retries}/${CONFIG.MAX_RETRIES})`);
            scheduleNextJob(delay);
            return;
        }

        // Kifogytunk az újrapróbákból: ne blokkolja a sor többi elemét.
        job.retries = 0;
        job.deferrals = (job.deferrals || 0) + 1;
        if (job.deferrals > CONFIG.MAX_DEFERRALS) {
            console.error(`[Lisa] Munka eldobva ${job.deferrals} sikertelen kör után: ${job.jobName} – ${verdict.reason}`);
            updateUIStatus(`Feladva: ${job.jobName} (${verdict.reason})`);
            saveExtraQueueToStorage();
            updateExtraList();
            scheduleNextJob(2000);
            return;
        }
        requeueJob(job, true);
        updateUIStatus(`${job.jobName} a sor végére került (${verdict.reason})`);
        scheduleNextJob(rand(3000, 6000));
    }

    // ============================================================
    //  11. FELDOLGOZÁS
    // ============================================================
    function ensureProcessing() {
        if (!processing && !paused && extraJobs.length > 0 && !nextJobTimer) {
            scheduleNextJob(500);
        }
    }

    function scheduleNextJob(delayMs) {
        if (nextJobTimer) clearTimeout(nextJobTimer);
        nextJobTimer = setTimeout(() => {
            nextJobTimer = null;
            processQueue();
        }, delayMs);
    }

    async function processQueue() {
        if (processing) return;
        processing = true;

        try {
            if (paused) {
                updateUIStatus('Szüneteltetve');
                return;
            }
            if (extraJobs.length === 0) {
                updateUIStatus('Nincs több munka az extra sorban.');
                return;
            }
            if (!cachedHash) {
                updateUIStatus('Hiányzó hash – indíts egy munkát manuálisan!');
                scheduleNextJob(10000);
                return;
            }
            // Ha tudjuk, hogy tele a sor, meg se próbáljuk: felesleges kérés lenne.
            if (isQueueFull()) {
                const waitMs = waitUntilFreeSlotMs();
                updateUIStatus(`Sor tele (${getQueueLength()}/${CONFIG.QUEUE_SIZE}) – ~${Math.round(waitMs / 1000)} mp`);
                scheduleNextJob(waitMs);
                return;
            }

            const job = extraJobs.shift();
            saveExtraQueueToStorage();
            updateUI();

            updateUIStatus(`Indítás: ${job.jobName} (még ${extraJobs.length} a sorban)`);
            console.log(`[Lisa] Munka indítása: ${job.jobName} (ID:${job.jobId})`);

            const slotIndex = getQueueLength() % CONFIG.QUEUE_SIZE;
            const bodyParams = new URLSearchParams();
            bodyParams.set(`tasks[${slotIndex}][jobId]`, job.jobId);
            bodyParams.set(`tasks[${slotIndex}][x]`, job.x);
            bodyParams.set(`tasks[${slotIndex}][y]`, job.y);
            bodyParams.set(`tasks[${slotIndex}][duration]`, job.duration);
            bodyParams.set(`tasks[${slotIndex}][taskType]`, job.taskType);

            let verdict;
            try {
                const fullUrl = `/game.php?window=task&action=add&h=${cachedHash}`;
                const headers = shuffleHeaders({
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                });

                const { status, responseText } = await sendXHR(fullUrl, 'POST', bodyParams.toString(), headers);
                verdict = classifyAddResponse(status, responseText);
            } catch (err) {
                console.error(`[Lisa] Kérés meghiúsult (${job.jobName}):`, err);
                verdict = { outcome: 'retry', reason: (err && err.message) || 'Hálózati hiba' };
            }

            applyVerdict(job, verdict);
        } finally {
            processing = false;
            // Vészfék: normál működésben az applyVerdict már ütemezett. Ha valamiért
            // mégsem, itt lassan indulunk újra – nem 500 ms-os pörgéssel.
            if (!paused && extraJobs.length > 0 && !nextJobTimer) scheduleNextJob(CONFIG.IDLE_RESCHEDULE);
        }
    }

    // ============================================================
    //  12. UI ÉS STORAGE
    // ============================================================
    function saveExtraQueueToStorage() {
        try {
            localStorage.setItem(CONFIG.STORAGE_EXTRA_QUEUE, JSON.stringify(extraJobs.map(j => ({
                id: j.id, retries: j.retries, deferrals: j.deferrals || 0, jobName: j.jobName,
                jobId: j.jobId, x: j.x, y: j.y, duration: j.duration, taskType: j.taskType,
            }))));
        } catch(e) {}
    }
    function loadExtraQueueFromStorage() {
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_EXTRA_QUEUE);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) extraJobs = parsed.filter(j => j.jobId !== undefined);
                localStorage.removeItem(CONFIG.STORAGE_EXTRA_QUEUE);
            }
        } catch(e) {}
    }
    function saveHistoryToStorage() {
        try { localStorage.setItem(CONFIG.STORAGE_HISTORY, JSON.stringify(jobHistory)); } catch(e) {}
    }
    function loadHistoryFromStorage() {
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_HISTORY);
            if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) jobHistory = parsed; }
        } catch(e) {}
    }

    // --- Menüsor gomb kezelése ---
    function createShowButton() {
        if (showButton) return;
        const menubar = document.getElementById('ui_menubar');
        if (!menubar) return;

        const container = document.createElement('div');
        container.className = 'ui_menucontainer';
        container.id = 'lisa-show-container';
        container.innerHTML = `
            <div class="menulink lisa-show-btn" title="Lisa Extra Queue megjelenítése">LQ</div>
            <div class="menucontainer_bottom"></div>
        `;
        menubar.appendChild(container);
        showButton = container.querySelector('.lisa-show-btn');
        showButton.addEventListener('click', showLisaPanel);

        // Némi stílus, hogy illeszkedjen a menühöz
        const btnStyle = document.createElement('style');
        btnStyle.textContent = `
            .lisa-show-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                font-size: 12px;
                color: #e6d5b8;
                background: rgba(70, 55, 35, 0.9);
                border: 1px solid #b89a6b;
                border-radius: 3px;
                cursor: pointer;
                width: 28px;
                height: 28px;
                margin: 2px;
            }
            .lisa-show-btn:hover {
                background: #b89a6b;
                color: #1e160e;
            }
        `;
        document.head.appendChild(btnStyle);
    }

    function removeShowButton() {
        const container = document.getElementById('lisa-show-container');
        if (container) container.remove();
        showButton = null;
    }

    function showLisaPanel() {
        if (uiPanel) {
            uiPanel.style.display = 'block';
            removeShowButton();
        }
    }

    function hideLisaPanel() {
        if (uiPanel) {
            uiPanel.style.display = 'none';
            createShowButton();
        }
    }

    function injectUI() {
        const style = document.createElement('style');
        style.textContent = `
            #lisa-panel {
                position: fixed;
                top: 140px;                  /* Térkép alá – saját pozíciód szerint */
                right: 35px;                /* Jobb széltől kicsit beljebb */
                width: ${CONFIG.PANEL_WIDTH}px;
                background: rgba(90, 75, 60, 0.95); /* Világosabb barna háttér */
                border: 1px solid #b89a6b;
                border-radius: 6px;
                color: #e6d5b8;
                font-family: 'Georgia', 'Times New Roman', serif;
                box-shadow: 0 4px 12px rgba(0,0,0,0.6);
                z-index: 99999;
                user-select: none;
                backdrop-filter: blur(3px);
                display: flex;
                flex-direction: column;
                max-height: calc(100vh - 160px);
            }
            #lisa-panel .header {
                cursor: move;
                font-weight: bold;
                border-bottom: 1px solid #b89a6b;
                padding: 6px 10px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: rgba(50, 40, 30, 0.8);
                border-radius: 6px 6px 0 0;
                font-size: 14px;
                color: #f0e4c6;
            }
            #lisa-panel .controls button {
                background: none;
                border: 1px solid #b89a6b;
                color: #e6d5b8;
                margin-left: 4px;
                cursor: pointer;
                font-family: inherit;
                font-size: 12px;
                padding: 2px 6px;
                border-radius: 3px;
                background: rgba(70, 55, 35, 0.8);
            }
            #lisa-panel .controls button:hover {
                background: #b89a6b;
                color: #1e160e;
            }
            #lisa-panel .status {
                color: #c8b48c;
                font-size: 11px;
                margin: 4px 10px;
                font-style: italic;
            }
            #lisa-panel .tab-bar {
                display: flex;
                margin: 0 6px;
            }
            #lisa-panel .tab {
                flex: 1;
                text-align: center;
                padding: 4px;
                border: 1px solid #b89a6b;
                cursor: pointer;
                background: rgba(60, 50, 40, 0.8);
                border-radius: 4px 4px 0 0;
                font-size: 12px;
                color: #c8b48c;
                margin-right: -1px;
            }
            #lisa-panel .tab.active {
                background: #b89a6b;
                color: #1e160e;
                font-weight: bold;
                border-bottom: 1px solid #b89a6b;
            }
            #lisa-panel .list-container {
                flex: 1;
                overflow-y: auto;
                border: 1px solid #5a4a3a;
                margin: 0 6px 4px;
                background: rgba(40, 30, 25, 0.9);
                min-height: 40px;
                max-height: 250px;
            }
            #lisa-panel ul {
                list-style: none;
                padding: 0;
                margin: 0;
            }
            #lisa-panel li {
                padding: 3px 8px;
                border-bottom: 1px dotted #5a4a3a;
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 12px;
            }
            #lisa-panel li .remove {
                color: #c06050;
                cursor: pointer;
                font-weight: bold;
                margin-left: 6px;
                font-size: 14px;
            }
            #lisa-panel li .remove:hover {
                color: #ff7070;
            }
            #lisa-panel .extra-controls, #lisa-panel .history-controls {
                padding: 5px 8px;
                border-top: 1px solid #5a4a3a;
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 11px;
            }
            #lisa-panel .extra-controls button, #lisa-panel .history-controls button {
                background: rgba(70, 55, 35, 0.8);
                border: 1px solid #b89a6b;
                color: #e6d5b8;
                cursor: pointer;
                font-family: inherit;
                font-size: 11px;
                padding: 3px 8px;
                border-radius: 3px;
            }
            #lisa-panel .extra-controls button:hover, #lisa-panel .history-controls button:hover {
                background: #b89a6b;
                color: #1e160e;
            }
            #lisa-panel .count-info {
                font-size: 10px;
                color: #8a7a6a;
            }
            .lisa-count-input {
                width: 45px;
                background: rgba(30, 25, 20, 0.9);
                border: 1px solid #5a4a3a;
                color: #e6d5b8;
                font-family: inherit;
                text-align: center;
                margin-left: 6px;
                border-radius: 3px;
            }
            .lisa-job-name {
                flex-grow: 1;
                margin-right: 10px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #lisa-queue-selected:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #lisa-hash-status {
                font-size: 11px;
                margin-left: 8px;
                font-weight: normal;
            }
        `;
        document.head.appendChild(style);

        uiPanel = document.createElement('div');
        uiPanel.id = 'lisa-panel';
        uiPanel.innerHTML = `
            <div class="header">
                <span>Extra Queue <span id="lisa-hash-status">Hash: nincs</span></span>
                <div class="controls">
                    <button id="lisa-pause-btn" title="Szünet / Folytatás">⏸️</button>
                    <button id="lisa-hide-btn" title="Elrejtés">_</button>
                </div>
            </div>
            <div class="status" id="lisa-status">Inicializálás...</div>
            <div class="tab-bar">
                <div id="tab-extra" class="tab active">Extra Sor</div>
                <div id="tab-history" class="tab">Előzmények</div>
            </div>
            <div id="extra-tab-content">
                <div class="list-container"><ul id="lisa-extra-list"></ul></div>
                <div class="extra-controls">
                    <button id="lisa-clear-extra">Törlés</button>
                    <span class="count-info">Munkák: <span id="lisa-extra-count">0</span></span>
                </div>
            </div>
            <div id="history-tab-content" style="display:none;">
                <div class="list-container"><ul id="lisa-history-list"></ul></div>
                <div class="history-controls">
                    <button id="lisa-queue-selected">Kiválasztottak sorba</button>
                    <button id="lisa-clear-history">Előzmények törlése</button>
                    <span class="count-info">Rögzítve: <span id="lisa-history-count">0</span></span>
                </div>
            </div>
        `;
        document.body.appendChild(uiPanel);

        uiStatus = document.getElementById('lisa-status');
        uiExtraList = document.getElementById('lisa-extra-list');
        uiHistoryList = document.getElementById('lisa-history-list');
        uiExtraCount = document.getElementById('lisa-extra-count');
        uiHistoryCount = document.getElementById('lisa-history-count');
        uiHashStatus = document.getElementById('lisa-hash-status');
        addButton = document.getElementById('lisa-queue-selected');

        document.getElementById('lisa-pause-btn').addEventListener('click', togglePause);
        document.getElementById('lisa-hide-btn').addEventListener('click', hideLisaPanel);   // átkötve az új függvényre
        document.getElementById('lisa-clear-extra').addEventListener('click', clearExtraQueue);
        addButton.addEventListener('click', addSelectedToExtra);
        document.getElementById('lisa-clear-history').addEventListener('click', clearHistory);
        document.getElementById('tab-extra').addEventListener('click', () => switchTab('extra'));
        document.getElementById('tab-history').addEventListener('click', () => switchTab('history'));

        makeDraggable(uiPanel);
        updateHashStatus();
        updateUI();
        updateUIStatus('Kész. Indíts egy munkát a hash megszerzéséhez.');
    }

    function switchTab(tab) {
        document.getElementById('tab-extra').classList.toggle('active', tab === 'extra');
        document.getElementById('tab-history').classList.toggle('active', tab === 'history');
        document.getElementById('extra-tab-content').style.display = tab === 'extra' ? 'block' : 'none';
        document.getElementById('history-tab-content').style.display = tab === 'history' ? 'block' : 'none';
    }

    function makeDraggable(el) {
        const header = el.querySelector('.header');
        let offsetX, offsetY, startX, startY;
        header.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            startY = e.clientY;
            offsetX = el.offsetLeft;
            offsetY = el.offsetTop;
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', stopDrag);
        });
        function onDrag(e) {
            el.style.left = (offsetX + e.clientX - startX) + 'px';
            el.style.top = (offsetY + e.clientY - startY) + 'px';
            el.style.bottom = 'auto';
            el.style.right = 'auto';
        }
        function stopDrag() {
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', stopDrag);
        }
    }

    function updateUI() { updateExtraList(); updateHistoryList(); }
    function updateExtraList() {
        if (!uiExtraList) return;
        uiExtraList.innerHTML = '';
        extraJobs.forEach((job, idx) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="lisa-job-name" title="${job.jobName} (ID:${job.jobId}, x:${job.x}, y:${job.y})">${job.jobName} <small>(ID:${job.jobId})</small></span><span class="remove" data-index="${idx}">✕</span>`;
            li.querySelector('.remove').addEventListener('click', () => {
                extraJobs.splice(idx, 1);
                saveExtraQueueToStorage();
                updateExtraList();
            });
            uiExtraList.appendChild(li);
        });
        if (uiExtraCount) uiExtraCount.textContent = extraJobs.length;
    }
    function updateHistoryList() {
        if (!uiHistoryList) return;
        uiHistoryList.innerHTML = '';
        jobHistory.forEach((job, idx) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="lisa-job-name"><input type="checkbox" class="hist-check" data-index="${idx}">${job.jobName} <small>(ID:${job.jobId}, ${job.duration}s)</small></span><span><input type="number" class="lisa-count-input" value="1" min="1" max="99" data-index="${idx}"></span>`;
            uiHistoryList.appendChild(li);
        });
        if (uiHistoryCount) uiHistoryCount.textContent = jobHistory.length;
    }

    function togglePause() {
        paused = !paused;
        document.getElementById('lisa-pause-btn').textContent = paused ? '▶️' : '⏸️';
        updateUIStatus(paused ? 'Szüneteltetve' : 'Folytatva');
        if (paused) {
            if (nextJobTimer) {
                clearTimeout(nextJobTimer);
                nextJobTimer = null;
            }
        } else ensureProcessing();
    }

    function clearExtraQueue() {
        extraJobs = [];
        saveExtraQueueToStorage();
        updateExtraList();
        updateUIStatus('Extra sor törölve.');
    }
    function clearHistory() {
        jobHistory = [];
        saveHistoryToStorage();
        updateHistoryList();
        updateUIStatus('Előzmények törölve.');
    }

    function addSelectedToExtra() {
        if (addingFromHistory) return;
        if (!cachedHash) {
            alert('Lisa: Nincs érvényes hash!');
            return;
        }
        addingFromHistory = true;
        addButton.disabled = true;
        setTimeout(() => { addingFromHistory = false; addButton.disabled = false; }, CONFIG.BUTTON_COOLDOWN);

        const checks = document.querySelectorAll('.hist-check:checked');
        if (checks.length === 0) {
            alert('Válassz ki legalább egy munkát!');
            return;
        }
        const jobsToAdd = [];
        checks.forEach(cb => {
            const idx = parseInt(cb.getAttribute('data-index'), 10);
            const count = parseInt(document.querySelector(`.lisa-count-input[data-index="${idx}"]`)?.value) || 1;
            if (idx >= 0 && idx < jobHistory.length) {
                const j = jobHistory[idx];
                for (let i = 0; i < count; i++) jobsToAdd.push({ jobId: j.jobId, x: j.x, y: j.y, duration: j.duration, taskType: j.taskType, jobName: j.jobName });
            }
        });
        jobsToAdd.forEach(job => addExtraJob(job, job.jobName, false));
        updateUI();
        updateUIStatus(`${checks.length} típusú munka hozzáadva.`);
        ensureProcessing();
    }

    // ============================================================
    // BOOT
    // ============================================================
    function onDOMReady() {
        const checkDOM = setInterval(() => {
            if (document.querySelector('#ui_workcontainer') || document.querySelector('#ui_bottomright')) {
                clearInterval(checkDOM);
                loadExtraQueueFromStorage();
                loadHistoryFromStorage();
                // A sor állapota túléli az újratöltést: a date_done abszolút szerveridő,
                // így F5 után is tudjuk, hány slot foglalt és meddig.
                loadGameQueueFromStorage();
                injectUI();
                updateUI();
                updateUIStatus('Kész. Indíts egy munkát a hash megszerzéséhez.');
                initAmountPatch();
                if (extraJobs.length > 0) ensureProcessing();
            }
        }, 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDOMReady);
    else onDOMReady();

    console.log('[Lisa] Modular v10.20 (menü gomb, világosabb barna) betöltve.');
})();
