// ==UserScript==
// @name         The-West Modular Job Queue (Lisa v11.3 - Várakozók a játék sorában)
// @namespace   http://tampermonkey.net/
// @version     11.3
// @description A játék saját TaskQueue-ján keresztül indít munkát, a maradékot FIFO sorrendben sorba állítja, várható kezdés/befejezés kijelzéssel.
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
        MAX_RETRIES: 5,              // ennyi hiba után a munka a sor végére kerül
        MAX_DEFERRALS: 2,            // ennyi sikertelen kör után eldobjuk
        IDLE_RESCHEDULE: 5000,       // vészfék: ha egy ág elfelejtene időzítőt állítani
        // Verziófüggetlen kulcsok: a verziószám a tartalomban van, nem a kulcsban,
        // különben minden kiadás elárvasítaná a felhasználó elmentett sorát.
        STORAGE_EXTRA_QUEUE: 'lisa_extra_queue',
        STORAGE_HISTORY: 'lisa_history',
        STORAGE_LEADER: 'lisa_leader_tab',
        STORAGE_VERSION: 2,
        LEGACY_EXTRA_QUEUE: 'lisa_extra_params_v1020',
        LEGACY_HISTORY: 'lisa_modular_history_v97',
        MIN_SEND_GAP: 2000,          // két egymást követő küldés között
        WATCH_INTERVAL: 2000,        // ilyen sűrűn nézzük a játék sorát és az időpontokat
        SLOT_FREED_DELAY: 1500,      // felszabadult slot után ennyivel indítjuk a következőt
        MAX_WAIT_MS: 3600000,        // egy hibás date_done se tudja örökre megállítani
        TIMER_CHUNK: 60000,          // hosszú várakozást ekkora darabokban ébresztünk
        LEADER_HEARTBEAT: 5000,
        LEADER_TTL: 15000,           // ennyi néma szívverés után átvehető a feldolgozás
        MAX_HISTORY: 60,
        BOOT_MAX_ATTEMPTS: 60,
        PANEL_WIDTH: 320,
        BUTTON_COOLDOWN: 1500,
        MAX_AMOUNT: 99,
        MIN_AMOUNT: 1,
        FALLBACK_QUEUE_LIMIT: 4,     // csak ha a játék TaskQueue-ja elérhetetlen
        DEFAULT_DURATION: 900,       // csak ha se a DOM-ból, se az előzményekből nem derül ki
        MAX_EXTRA_QUEUE: 500,
        GAME_QUEUE_PREVIEW: 8,       // ennyi várakozó munka látszik a játék sorában
        PANEL_PREVIEW: 12,           // ennyi látszik a script paneljén
    };

    // ============================================================
    //  2. BELSŐ ÁLLAPOTOK
    // ============================================================
    let extraJobs = [];
    let jobHistory = [];
    let paused = false;
    let pendingJobName = null;
    let pendingJobAmount = 0;
    let pendingQueueLengthBefore = 0;
    let processing = false;
    let nextJobTimer = null;
    let nextJobDeadline = 0;
    let isLeaderTab = true;
    let dialogCloseTimer = null;
    let lastSeenQueueLen = 0;
    let renderedPendingKey = '';

    let uiPanel, uiExtraList, uiHistoryList, uiStatus, uiExtraCount, uiHistoryCount;
    let uiQueueStatus;
    let addingFromHistory = false;
    let addButton = null;
    let showButton = null; // a menüsorban lévő gomb

    const OriginalXHR = window.XMLHttpRequest;

    // ============================================================
    //  3. SEGÉDFÜGGVÉNYEK
    // ============================================================
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const TAB_ID = generateId();

    function formatDuration(seconds) {
        const s = Math.max(0, Math.round(seconds || 0));
        if (s < 60) return `${s} mp`;
        if (s < 3600) return `${Math.round(s / 60)} p`;
        const h = Math.floor(s / 3600);
        const m = Math.round((s % 3600) / 60);
        return m ? `${h} ó ${m} p` : `${h} ó`;
    }

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

    function updateUIStatus(text) {
        if (uiStatus) uiStatus.textContent = text;
    }

    // A fejlécben a játék sorának élő állapota látszik. Korábban itt a
    // munkamenet-hash volt, amire a TaskQueue.add óta nincs szükség.
    function updateQueueBadge() {
        if (!uiQueueStatus) return;
        if (!gameReady()) {
            uiQueueStatus.textContent = 'Sor: –';
            uiQueueStatus.style.color = '#a04040';
            return;
        }
        const len = gameQueueLength(), lim = gameQueueLimit();
        uiQueueStatus.textContent = `Sor: ${len}/${lim}`;
        uiQueueStatus.style.color = len >= lim ? '#c88a5a' : '#c8a96e';
    }

    // ============================================================
    //  4. A JÁTÉK MUNKASORA (ÉLŐ, A JÁTÉK SAJÁT ÁLLAPOTÁBÓL)
    // ============================================================
    // A TaskQueue a játék saját, élő munkasora. Semmit nem modellezünk és nem
    // tárolunk róla: minden kérdésre ő a hiteles válasz. Korábban a script
    // XHR-válaszokból próbálta kitalálni a sor állapotát, és minden eltérés
    // ebből a találgatásból származott.
    function gameReady() {
        return typeof window.TaskQueue === 'object' && window.TaskQueue !== null
            && Array.isArray(window.TaskQueue.queue) && typeof window.TaskJob === 'function';
    }

    function gameQueueLength() {
        return gameReady() ? window.TaskQueue.queue.length : 0;
    }

    // A sorhossz prémiummal 9, anélkül 4 -- a játéktól kérdezzük, nem beégetjük.
    function gameQueueLimit() {
        if (!gameReady()) return CONFIG.FALLBACK_QUEUE_LIMIT;
        const lim = window.TaskQueue.limit;
        if (typeof lim === 'number') return lim;
        if (!lim) return CONFIG.FALLBACK_QUEUE_LIMIT;
        try {
            return window.Premium && Premium.hasBonus('automation') ? lim.premium : lim.normal;
        } catch(e) {
            return lim.normal || CONFIG.FALLBACK_QUEUE_LIMIT;
        }
    }

    function freeSlots() { return Math.max(0, gameQueueLimit() - gameQueueLength()); }

    // A sorelemek date_done-ja MÁSODPERC helyett ezredmásodperc, és a játék
    // tartja karban -- nincs szükség szerver-kliens óraegyeztetésre.
    function nextFreeAtMs() {
        if (!gameReady()) return null;
        const times = window.TaskQueue.queue
            .map(t => t && t.data && t.data.date_done)
            .filter(t => typeof t === 'number' && t > 0);
        return times.length ? Math.min(...times) : null;
    }

    function waitUntilFreeSlotMs() {
        const freeAt = nextFreeAtMs();
        if (!freeAt) return rand(CONFIG.FULL_QUEUE_POLL_MIN, CONFIG.FULL_QUEUE_POLL_MAX);
        const wait = Math.max(0, freeAt - Date.now()) + CONFIG.SAFETY_MARGIN_MS;
        return Math.min(Math.max(wait, CONFIG.MIN_SEND_GAP), CONFIG.MAX_WAIT_MS);
    }

    // ------------------------------------------------------------
    //  Várható kezdés / befejezés
    // ------------------------------------------------------------
    // A Character.calcWayTo(x, y) az AKTUÁLIS pozícióból adja meg az odajutás
    // idejét másodpercben, de a láncoláshoz tetszőleges két pont közti idő kell.
    // Mérésekkel ellenőrizve: az idő pontosan lineáris az euklideszi távolsággal
    // (a másodperc/egység arány minden irányban és távolságon azonos volt), ezért
    // az arányt futásidőben kiolvassuk egy ismert eltolással. Így a ló, a sebesség-
    // buffok és a jövőbeli egyensúlyozás is automatikusan érvényesül, beégetett
    // szorzó nélkül.
    function secondsPerDistanceUnit() {
        try {
            const c = window.Character;
            if (!c || typeof c.calcWayTo !== 'function') return null;
            const p = typeof c.getPosition === 'function' ? c.getPosition() : c.position;
            if (!p || typeof p.x !== 'number') return null;
            const probe = c.calcWayTo(p.x + 1000, p.y);
            if (typeof probe !== 'number' || !isFinite(probe) || probe <= 0) return null;
            return probe / 1000;
        } catch(e) { return null; }
    }

    function currentPosition() {
        try {
            const c = window.Character;
            const p = c && (typeof c.getPosition === 'function' ? c.getPosition() : c.position);
            return (p && typeof p.x === 'number') ? { x: p.x, y: p.y } : null;
        } catch(e) { return null; }
    }

    // A játék sora szekvenciális: az extra munkák a jelenleg LEGKÉSŐBB végző után
    // futnak, nem az első szabad slotnál. A lánc innen indul, onnan, ahol az a
    // munka véget ér -- ezért kell a helyszíne is, az odautazás miatt.
    function queueTailAnchor() {
        const now = Date.now();
        let tail = null;
        if (gameReady()) {
            for (const e of window.TaskQueue.queue) {
                const done = e && e.data && e.data.date_done;
                if (typeof done === 'number' && done > 0 && (!tail || done > tail.at)) {
                    tail = { at: done, pos: (e.post && typeof e.post.x === 'number') ? { x: e.post.x, y: e.post.y } : null };
                }
            }
        }
        return {
            at: tail ? Math.max(now, tail.at) : now,
            pos: (tail && tail.pos) || currentPosition(),
        };
    }

    // [{ id, start, finish, travelMs }] az extraJobs sorrendjében.
    function computeEtas(jobs) {
        const perUnit = secondsPerDistanceUnit();
        const anchor = queueTailAnchor();
        let at = anchor.at;
        let pos = anchor.pos;

        return jobs.map(job => {
            let travelMs = 0;
            if (perUnit !== null && pos && typeof job.x === 'number') {
                travelMs = Math.hypot(job.x - pos.x, job.y - pos.y) * perUnit * 1000;
            }
            const start = at + travelMs;
            const finish = start + (job.duration || 0) * 1000;
            at = finish;
            if (typeof job.x === 'number') pos = { x: job.x, y: job.y };
            return { id: job.id, start, finish, travelMs, estimated: perUnit !== null };
        });
    }

    function clockHM(ms) {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    // Több napra előre nyúló sornál a puszta óra:perc félrevezető lenne.
    function dayOffset(ms) {
        const a = new Date(); a.setHours(0, 0, 0, 0);
        const b = new Date(ms); b.setHours(0, 0, 0, 0);
        const days = Math.round((b - a) / 86400000);
        return days > 0 ? `+${days}` : '';
    }

    function formatEta(eta) {
        return `${clockHM(eta.start)}→${clockHM(eta.finish)}${dayOffset(eta.finish)}`;
    }

    // ------------------------------------------------------------
    //  Várakozó munkák a játék sorában (kizárólag megjelenítés)
    // ------------------------------------------------------------
    // A #queuedTasks tartalma a játéké, oda nem írunk. A saját elemeink külön
    // konténerbe kerülnek, közvetlenül alá, a játék osztályneveivel -- így a
    // megjelenés azonos, de a játék DOM-ját nem módosítjuk.
    //
    // A konténer szülőjén (.middle) a játéknak KÖZVETLEN click-kezelője van,
    // ami a taskAbort / taskHalveway / taskInstantFinish / centermap / icon
    // osztályokra reagál, és a queueId-t az osztálynévből olvassa ki. A mi
    // sorainkhoz nem tartozik valódi munka, ezért egyetlen kattintást sem
    // engedünk feljebb jutni -- enélkül egy kattintás valódi munkát szakítana meg.
    function pendingIconUrl(job) {
        try {
            if (!gameReady()) return null;
            const probe = new window.TaskJob(job.jobId, job.x, job.y, job.duration);
            const icon = typeof probe.getIcon === 'function' ? probe.getIcon() : null;
            return (typeof icon === 'string' && icon) ? icon : null;
        } catch(e) { return null; }
    }

    function formatClock(seconds) {
        const s = Math.max(0, Math.round(seconds || 0));
        return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
            .map(v => String(v).padStart(2, '0')).join(':');
    }

    function injectPendingStyles() {
        if (document.getElementById('lisa-pending-style')) return;
        const st = document.createElement('style');
        st.id = 'lisa-pending-style';
        st.textContent = `
            .lisa-pending { opacity: 0.68; }
            .lisa-pending:hover { opacity: 0.95; }
            .lisa-pending .taskAbort { cursor: pointer; }
            #queuedTasks .lisa-pending-sep {
                display: block;
                clear: both;
                border-top: 1px dashed #b89a6b;
                margin: 4px 2px 2px;
                padding-top: 2px;
                font: italic 10px 'Georgia','Times New Roman',serif;
                color: #4a3b28;
                text-align: center;
                text-shadow: 0 1px 0 rgba(255,255,255,0.45);
            }
            #queuedTasks .lisa-pending-more {
                display: inline-block;
                vertical-align: top;
                font: bold 13px 'Georgia','Times New Roman',serif;
                color: #4a3b28;
                padding: 24px 10px;
                text-shadow: 0 1px 0 rgba(255,255,255,0.45);
            }
        `;
        document.head.appendChild(st);
    }

    // A játék .task/.icon szabályai a #queuedTasks-hoz vannak kötve: külön
    // konténerben a méret és az ikon nem érvényesül. Ezért a sorainkat magába a
    // #queuedTasks-ba fűzzük, MINDIG a valódi elemek után. A játék a gyerekeket
    // indexre képezi le, így a végére fűzés a valódi elemek leképezését nem
    // bántja, a tick pedig nem építi újra a listát (méréssel ellenőrizve).
    function pendingHost() {
        const q = document.getElementById('queuedTasks');
        return (q && q.isConnected) ? q : null;
    }

    function clearPendingRows(host) {
        host.querySelectorAll('.lisa-pending, .lisa-pending-sep, .lisa-pending-more')
            .forEach(el => el.remove());
    }

    function buildPendingItem(job, eta) {
        const item = document.createElement('span');
        item.className = 'task lisa-pending';   // a 'task' hozza a játék stílusát
        item.dataset.id = job.id;

        const time = document.createElement('div');
        time.className = 'taskTime';
        const p = document.createElement('p');
        p.textContent = formatClock(job.duration);
        time.appendChild(p);

        const btns = document.createElement('div');
        btns.className = 'taskBtns';
        const abort = document.createElement('div');
        abort.className = 'taskAbort lisa-pending-abort';
        abort.title = 'Eltávolítás az extra sorból';
        btns.appendChild(abort);

        const icon = document.createElement('div');
        icon.className = 'icon';
        const url = pendingIconUrl(job);
        if (url) icon.style.backgroundImage = `url("${url}")`;

        item.appendChild(time);
        item.appendChild(btns);
        item.appendChild(icon);
        item.title = eta
            ? `${job.jobName} — ${formatDuration(job.duration)}, várható: ${formatEta(eta)}`
            : `${job.jobName} — ${formatDuration(job.duration)} (várakozik)`;

        item.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            e.preventDefault();
            if (e.target.closest('.lisa-pending-abort')) removeExtraJobById(job.id);
        }, true);

        return item;
    }

    function renderPendingInGameQueue() {
        injectPendingStyles();
        const host = pendingHost();
        if (!host) return;

        if (!extraJobs.length) {
            if (renderedPendingKey !== '') { clearPendingRows(host); renderedPendingKey = ''; }
            return;
        }

        const shown = extraJobs.slice(0, CONFIG.GAME_QUEUE_PREVIEW);
        const hidden = extraJobs.length - shown.length;
        // A figyelő 2 mp-enként hív. Csak akkor építünk újra, ha változott a lista,
        // vagy ha a játék újrarajzolása közben eltűntek a soraink (öngyógyítás).
        const key = `${extraJobs.length}|${shown.map(j => j.id).join(',')}`;
        if (key === renderedPendingKey && host.querySelector('.lisa-pending-sep')) return;
        renderedPendingKey = key;

        clearPendingRows(host);
        const etas = computeEtas(extraJobs);

        const sep = document.createElement('div');
        sep.className = 'lisa-pending-sep';
        sep.textContent = `Extra sor — ${extraJobs.length}`;
        host.appendChild(sep);

        shown.forEach((job, i) => host.appendChild(buildPendingItem(job, etas[i])));

        if (hidden > 0) {
            const more = document.createElement('span');
            more.className = 'lisa-pending-more';
            more.textContent = `+${hidden}`;
            more.title = `${hidden} további munka a listában`;
            host.appendChild(more);
        }
    }

    // A játék saját add-ját hívjuk, nem nyers XHR-t. Így a hash, a slotkezelés
    // és a limitellenőrzés a játék dolga, a jobb alsó sor-UI is frissül (nyers
    // XHR-rel a szerver tudott a munkáról, a játék kliense nem), és ha tele a
    // sor, a játék el sem küldi a kérést. A visszatérési érték abból derül ki,
    // hogy a sor hossza nőtt-e: a TaskQueue szinkron módon push-ol.
    // Egy kötegben adjuk át, ahogy a játék is teszi: így egy kérés megy ki
    // több munkára, nem N darab. A visszatérési érték a ténylegesen elfogadott
    // munkák száma -- a sor hossza szinkron módon nő, tehát azonnal mérhető.
    function startJobsViaGame(jobs) {
        if (!gameReady() || !jobs.length) return 0;
        const before = gameQueueLength();
        try {
            window.TaskQueue.add(jobs.map(j => new window.TaskJob(j.jobId, j.x, j.y, j.duration)));
        } catch(e) {
            console.error('[Lisa] TaskQueue.add hiba:', e);
            return 0;
        }
        return Math.max(0, gameQueueLength() - before);
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
    //  6. "TÖBB MUNKA?" DIALÓGUS AUTOMATIKUS BEZÁRÁSA
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
        // Gyors egymás utáni kattintásnál eddig több figyelő pörgött egyszerre.
        if (dialogCloseTimer) clearInterval(dialogCloseTimer);
        let attempts = 0;
        const maxAttempts = 10;
        dialogCloseTimer = setInterval(() => {
            if (closeMoreJobsDialog() || attempts >= maxAttempts) {
                clearInterval(dialogCloseTimer);
                dialogCloseTimer = null;
            }
            attempts++;
        }, 200);
    }

    // ============================================================
    //  7. JOB ADATOK KINYERÉSE (FALLBACKHEZ)
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
    //  9. XHR INTERCEPTOR
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

        const jobData = gameReady() ? parseJobWindow(jobWindow) : null;
        if (!jobData) {
            // Nem tudjuk kiolvasni a munka adatait: maradjon a játéké a kattintás,
            // a maradékot a válasz után, az élő sorhosszból számoljuk ki.
            console.warn('[Lisa] A munka adatai nem olvashatók ki – a játék kezeli a kattintást.');
            scheduleDialogClose();
            pendingJobName = jobName;
            pendingJobAmount = amount;
            pendingQueueLengthBefore = gameQueueLength();
            return;
        }

        // Minden kattintást mi kezelünk. A teljes köteg a lista végére kerül, a
        // feldolgozó pedig azonnal elindítja annyit, amennyi befér. Így a sorrend
        // mindig FIFO -- a szabad slotokba sem tudnak beelőzni az új munkák --,
        // és mivel a játék saját TaskQueue.add-ját hívjuk, a jobb alsó sor-UI is
        // frissül (nyers XHR-nél a szerver tudott a munkáról, a kliens nem).
        e.stopImmediatePropagation();
        e.preventDefault();

        const name = jobName || `Job #${jobData.jobId}`;
        const added = addExtraJobs(jobData, amount, name);
        addJobToHistory({ ...jobData, jobName: name });
        updateUI();
        updateUIStatus(`${added} munka sorba állítva (${extraJobs.length} várakozik).`);
        ensureProcessing();
    }, true);

    function InterceptedXHR() {
        const xhr = new OriginalXHR();
        const origOpen = xhr.open;
        const origSend = xhr.send;
        let reqUrl = '', reqMethod = '', reqBody = null, loadBound = false;

        xhr.open = function(method, url, ...rest) {
            reqMethod = String(method || '').toUpperCase();
            reqUrl = String(url || '');
            return origOpen.apply(this, [method, url, ...rest]);
        };

        xhr.send = function(body) {
            reqBody = body;
            if (loadBound) return origSend.apply(this, arguments); // újrahasznált xhr: ne kössünk kétszer
            loadBound = true;
            xhr.addEventListener('load', function() {
                if (reqMethod !== 'POST') return;
                if (!reqUrl.includes(CONFIG.JOB_ADD_ENDPOINT)) return;

                // Ide már csak az jut el, amit nem a saját feldolgozónk indított
                // (annál pendingJobAmount 0, mert nincs elkapott kattintás).
                const task = extractTaskFromBody(reqBody);
                if (!task) return;
                const jobName = pendingJobName || `Job #${task.jobId}`;
                addJobToHistory({ ...task, jobName });

                if (pendingJobAmount > 0) {
                    // A játék a TaskQueue-t még a kérés elküldése ELŐTT frissíti,
                    // így a válasz idejére az élő sorhossz már a valós állapot.
                    const added = Math.max(0, gameQueueLength() - pendingQueueLengthBefore);
                    const remaining = Math.max(0, pendingJobAmount - added);
                    console.log(`[Lisa] Játék indította: kért ${pendingJobAmount}, befért ${added}, maradék ${remaining}`);
                    if (remaining > 0) {
                        const queued = addExtraJobs(task, remaining, jobName);
                        updateUI();
                        updateUIStatus(`${queued} maradék munka az extra sorba helyezve.`);
                        ensureProcessing();
                    }
                }

                pendingJobName = null;
                pendingJobAmount = 0;
                pendingQueueLengthBefore = 0;
            });
            origSend.apply(this, arguments);
        };
        return xhr;
    }

    // A prototípust és a statikus konstansokat átvisszük: enélkül az
    // XMLHttpRequest.DONE undefined lett, és az `x instanceof XMLHttpRequest`
    // minden példányra false-t adott a játék és más userscriptek szemében.
    InterceptedXHR.prototype = OriginalXHR.prototype;
    ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(k => {
        InterceptedXHR[k] = OriginalXHR[k];
    });
    window.XMLHttpRequest = InterceptedXHR;

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
        if (jobHistory.length > CONFIG.MAX_HISTORY) jobHistory.length = CONFIG.MAX_HISTORY;
        saveHistoryToStorage();
        if (uiHistoryList) updateUI();
    }

    // ============================================================
    //  10. EXTRA SOR KEZELÉSE
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

    // ============================================================
    //  12. FELDOLGOZÁS
    // ============================================================
    function ensureProcessing() {
        if (!processing && !paused && extraJobs.length > 0 && !nextJobTimer) {
            scheduleNextJob(500);
        }
    }

    function scheduleNextJob(delayMs) {
        if (nextJobTimer) clearTimeout(nextJobTimer);
        nextJobDeadline = Date.now() + Math.max(0, delayMs);
        armNextJobTimer();
    }

    // Egy órás setTimeout háttérfülön vagy alvó gépen megbízhatatlan. Abszolút
    // határidőt tartunk, és legfeljebb TIMER_CHUNK-onként ébredünk ellenőrizni.
    function armNextJobTimer() {
        const remaining = nextJobDeadline - Date.now();
        if (remaining <= 0) {
            nextJobTimer = null;
            processQueue();
            return;
        }
        nextJobTimer = setTimeout(armNextJobTimer, Math.min(remaining, CONFIG.TIMER_CHUNK));
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
            // Csak egy fül dolgozhatja fel a sort, különben két példány
            // párhuzamosan küldene ugyanabból a listából.
            if (!isLeaderTab) {
                updateUIStatus(`Passzív fül – egy másik, látható fül dolgozza fel (${extraJobs.length} vár).`);
                scheduleNextJob(CONFIG.LEADER_HEARTBEAT);
                return;
            }
            if (!gameReady()) {
                updateUIStatus('A játék munkasora még nem érhető el...');
                scheduleNextJob(5000);
                return;
            }
            if (freeSlots() <= 0) {
                const waitMs = waitUntilFreeSlotMs();
                updateUIStatus(`Sor tele (${gameQueueLength()}/${gameQueueLimit()}) – ~${Math.round(waitMs / 1000)} mp`);
                scheduleNextJob(waitMs);
                return;
            }

            // FONTOS: csak megnézzük a sor elejét, nem vesszük le. A munkák
            // kizárólag akkor kerülnek ki a listából, ha a játék tényleg
            // elfogadta őket. Hibánál, elutasításnál, kivételnél sem tűnhet el
            // semmi -- ez szerkezetileg zárja ki a "munka eltűnt" hibaosztályt.
            const batch = extraJobs.slice(0, freeSlots());
            console.log(`[Lisa] Indítás: ${batch.length} munka (${batch[0].jobName}...), szabad slot: ${freeSlots()}`);

            const accepted = startJobsViaGame(batch);

            if (accepted > 0) {
                const started = extraJobs.splice(0, accepted);
                started.forEach(j => { j.retries = 0; });
                saveExtraQueueToStorage();
                updateUI();
                console.log(`[Lisa] Elfogadva ${accepted} munka (sor: ${gameQueueLength()}/${gameQueueLimit()})`);

                if (extraJobs.length === 0) {
                    updateUIStatus(`Kész – minden munka elindítva (sor: ${gameQueueLength()}/${gameQueueLimit()}).`);
                    return;
                }
                if (freeSlots() > 0) {
                    updateUIStatus(`${accepted} elindítva, még ${extraJobs.length} vár (sor: ${gameQueueLength()}/${gameQueueLimit()})`);
                    scheduleNextJob(rand(CONFIG.MIN_SEND_GAP, CONFIG.MIN_SEND_GAP + 1000));
                } else {
                    const waitMs = waitUntilFreeSlotMs();
                    updateUIStatus(`${accepted} elindítva, még ${extraJobs.length} – következő slot ~${Math.round(waitMs / 1000)} mp múlva`);
                    scheduleNextJob(waitMs);
                }
                return;
            }

            // A játék egyet sem fogadott el. A lista érintetlen, csak várunk.
            const job = extraJobs[0];
            job.retries = (job.retries || 0) + 1;
            const waitMs = waitUntilFreeSlotMs();
            console.warn(`[Lisa] A játék nem fogadta el: ${job.jobName} (${job.retries}. próba)`);
            updateUIStatus(`${job.jobName} nem indult el – újra ~${Math.round(waitMs / 1000)} mp múlva (${job.retries})`);

            // Ha sokadszorra sem megy és van más munka is, adjunk esélyt a többinek.
            if (job.retries > CONFIG.MAX_RETRIES && extraJobs.length > 1) {
                extraJobs.shift();
                job.retries = 0;
                job.deferrals = (job.deferrals || 0) + 1;
                if (job.deferrals <= CONFIG.MAX_DEFERRALS) {
                    extraJobs.push(job);
                    updateUIStatus(`${job.jobName} a sor végére került (nem indult el).`);
                } else {
                    console.error(`[Lisa] Munka eldobva ${job.deferrals} sikertelen kör után: ${job.jobName}`);
                    updateUIStatus(`Feladva: ${job.jobName} (nem indult el)`);
                }
                updateUI();
            }
            saveExtraQueueToStorage();
            scheduleNextJob(waitMs);
        } finally {
            processing = false;
            // Vészfék: normál működésben az applyVerdict már ütemezett. Ha valamiért
            // mégsem, itt lassan indulunk újra – nem 500 ms-os pörgéssel.
            if (!paused && extraJobs.length > 0 && !nextJobTimer) scheduleNextJob(CONFIG.IDLE_RESCHEDULE);
        }
    }

    // ============================================================
    //  13. UI ÉS STORAGE
    // ============================================================
    // A verziót a tartalomba írjuk, nem a kulcsba, és a régi kulcsokról egyszer
    // átköltöztetünk – így egy frissítés nem hagyja ott a felhasználó sorát.
    function saveStore(key, list) {
        try {
            localStorage.setItem(key, JSON.stringify({ v: CONFIG.STORAGE_VERSION, data: list }));
        } catch(e) {
            console.warn(`[Lisa] Nem sikerült menteni (${key}):`, e && e.name);
        }
    }

    function loadStore(key, legacyKey) {
        try {
            const raw = localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.data)) return parsed.data;
                if (Array.isArray(parsed)) return parsed; // verziózás előtti formátum
            }
            if (legacyKey) {
                const legacy = localStorage.getItem(legacyKey);
                if (legacy) {
                    const parsed = JSON.parse(legacy);
                    if (Array.isArray(parsed)) {
                        console.log(`[Lisa] Átköltöztetve a régi kulcsról: ${legacyKey}`);
                        return parsed;
                    }
                }
            }
        } catch(e) {
            console.warn(`[Lisa] Nem sikerült olvasni (${key}):`, e && e.name);
        }
        return null;
    }

    function sanitizeJobs(list) {
        return list
            .filter(j => j && j.jobId !== undefined && j.jobId !== null && !isNaN(parseInt(j.jobId, 10)))
            .map(j => ({
                id: j.id || generateId(),
                retries: parseInt(j.retries, 10) || 0,
                deferrals: parseInt(j.deferrals, 10) || 0,
                jobName: j.jobName || `Job #${j.jobId}`,
                jobId: parseInt(j.jobId, 10),
                x: parseInt(j.x, 10) || 0,
                y: parseInt(j.y, 10) || 0,
                duration: parseInt(j.duration, 10) || CONFIG.DEFAULT_DURATION,
                taskType: j.taskType || 'job',
            }))
            .slice(0, CONFIG.MAX_EXTRA_QUEUE);
    }

    function saveExtraQueueToStorage() {
        saveStore(CONFIG.STORAGE_EXTRA_QUEUE, extraJobs.map(j => ({
            id: j.id, retries: j.retries, deferrals: j.deferrals || 0, jobName: j.jobName,
            jobId: j.jobId, x: j.x, y: j.y, duration: j.duration, taskType: j.taskType,
        })));
    }

    function loadExtraQueueFromStorage() {
        const data = loadStore(CONFIG.STORAGE_EXTRA_QUEUE, CONFIG.LEGACY_EXTRA_QUEUE);
        if (data) extraJobs = sanitizeJobs(data);
        // Korábban itt removeItem állt, ezért egy azonnali újratöltés elvesztette
        // a sort. Most visszaírunk, hogy a tárolt állapot mindig érvényes legyen.
        saveExtraQueueToStorage();
    }
    function saveHistoryToStorage() {
        saveStore(CONFIG.STORAGE_HISTORY, jobHistory);
    }

    function loadHistoryFromStorage() {
        const data = loadStore(CONFIG.STORAGE_HISTORY, CONFIG.LEGACY_HISTORY);
        if (!data) return;
        jobHistory = data
            .filter(j => j && j.jobId !== undefined)
            .map(j => ({ ...j, id: j.id || generateId(), duration: parseInt(j.duration, 10) || CONFIG.DEFAULT_DURATION }))
            .slice(0, CONFIG.MAX_HISTORY);
    }

    // ============================================================
    //  14. TÖBB FÜL: EGYETLEN FELDOLGOZÓ
    // ============================================================
    // Két nyitott játékfül eddig ugyanabból a listából küldött párhuzamosan.
    // A vezető fül szívverést ír a localStorage-ba; a többi passzívan követi.
    function isVisible() {
        return document.visibilityState !== 'hidden';
    }

    function refreshLeadership() {
        const wasLeader = isLeaderTab;
        const visible = isVisible();
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_LEADER);
            const cur = raw ? JSON.parse(raw) : null;
            const now = Date.now();
            const stale = !cur || !cur.id || (now - cur.ts) > CONFIG.LEADER_TTL;
            const mine = !!cur && cur.id === TAB_ID;
            // A LÁTHATÓ fül mindig elveheti a vezetést egy háttérben lévőtől: a
            // felhasználó ott várja a munkát. Enélkül egy nyitva felejtett háttérfül
            // némán blokkolta a feldolgozást azon a fülön, amit a felhasználó néz --
            // és a UI csak annyit mondott, hogy "passzív fül".
            const canTakeOver = visible && cur && !cur.visible;

            if (stale || mine || canTakeOver) {
                localStorage.setItem(CONFIG.STORAGE_LEADER, JSON.stringify({ id: TAB_ID, ts: now, visible }));
                isLeaderTab = true;
            } else {
                isLeaderTab = false;
            }
        } catch(e) {
            isLeaderTab = true; // nincs használható storage: egyedül vagyunk
        }

        if (isLeaderTab && !wasLeader) {
            console.log('[Lisa] Ez a fül vette át a feldolgozást.');
            ensureProcessing();
        } else if (!isLeaderTab && wasLeader) {
            console.log('[Lisa] Egy másik, látható fül vette át a feldolgozást.');
        }
        // A vezető fül is ütemezzen, ha van mit tenni és épp nem várakozik időzítőre.
        if (isLeaderTab) ensureProcessing();
    }

    // A játék sora kívülről is rövidülhet: lejár egy munka, vagy a felhasználó
    // megszakít egyet. Ilyenkor nem várjuk ki a korábban beütemezett -- akár
    // percekben mért -- várakozást, hanem pár másodpercen belül indítjuk a
    // következőt. Kizárólag a sorhossz CSÖKKENÉSÉRE lépünk, így ha a játék
    // mégis elutasítaná az indítást, nem kezdünk el kétmásodpercenként próbálkozni.
    function watchGameQueue() {
        updateQueueBadge();
        updateExtraEtas();
        renderPendingInGameQueue();

        const len = gameQueueLength();
        const dropped = len < lastSeenQueueLen;
        lastSeenQueueLen = len;

        if (!dropped || paused || !isLeaderTab || processing) return;
        if (extraJobs.length === 0 || freeSlots() <= 0) return;

        const soon = Date.now() + CONFIG.SLOT_FREED_DELAY;
        if (!nextJobTimer || nextJobDeadline > soon) {
            console.log(`[Lisa] Slot szabadult (${len}/${gameQueueLimit()}), indítás hamarosan.`);
            scheduleNextJob(CONFIG.SLOT_FREED_DELAY);
        }
    }

    function releaseLeadership() {
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_LEADER);
            const cur = raw ? JSON.parse(raw) : null;
            // Csak a sajátunkat engedjük el, hogy egy másik fül azonnal átvehesse
            // ahelyett, hogy megvárná a TTL lejártát.
            if (cur && cur.id === TAB_ID) localStorage.removeItem(CONFIG.STORAGE_LEADER);
        } catch(e) {}
    }

    function initTabSync() {
        refreshLeadership();
        setInterval(refreshLeadership, CONFIG.LEADER_HEARTBEAT);

        // Fülváltásnál azonnal újraértékelünk, nem várunk a szívverésre.
        document.addEventListener('visibilitychange', refreshLeadership);
        // Bezáráskor elengedjük a vezetést: a bezárt fül eddig a TTL végéig fogta.
        window.addEventListener('pagehide', releaseLeadership);

        // A storage esemény csak a TÖBBI fülben sül el, tehát mindig idegen
        // változást jelez. Minden fül újratölt -- a vezető is, különben a
        // passzív fülben hozzáadott munkát a következő mentése felülírná.
        window.addEventListener('storage', (e) => {
            if (!e.key) return;
            if (e.key === CONFIG.STORAGE_EXTRA_QUEUE) {
                const data = loadStore(CONFIG.STORAGE_EXTRA_QUEUE);
                if (data) {
                    extraJobs = sanitizeJobs(data);
                    updateExtraList();
                    ensureProcessing();
                }
            } else if (e.key === CONFIG.STORAGE_HISTORY) {
                loadHistoryFromStorage();
                updateHistoryList();
            }
        });
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
            .lisa-more-row {
                justify-content: center;
                font-style: italic;
                color: #a99372;
                font-size: 11px;
            }
            .lisa-eta {
                font-size: 10px;
                color: #a99372;
                white-space: nowrap;
                margin-left: 4px;
                font-variant-numeric: tabular-nums;
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
            #lisa-queue-status {
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
                <span>Extra Queue <span id="lisa-queue-status">Sor: –</span></span>
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
        uiQueueStatus = document.getElementById('lisa-queue-status');
        addButton = document.getElementById('lisa-queue-selected');

        document.getElementById('lisa-pause-btn').addEventListener('click', togglePause);
        document.getElementById('lisa-hide-btn').addEventListener('click', hideLisaPanel);   // átkötve az új függvényre
        document.getElementById('lisa-clear-extra').addEventListener('click', clearExtraQueue);
        addButton.addEventListener('click', addSelectedToExtra);
        document.getElementById('lisa-clear-history').addEventListener('click', clearHistory);
        document.getElementById('tab-extra').addEventListener('click', () => switchTab('extra'));
        document.getElementById('tab-history').addEventListener('click', () => switchTab('history'));

        makeDraggable(uiPanel);
        updateQueueBadge();
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

    function updateUI() { updateExtraList(); updateHistoryList(); updateQueueBadge(); }

    function removeExtraJobById(id) {
        const idx = extraJobs.findIndex(j => j.id === id);
        if (idx === -1) return;
        extraJobs.splice(idx, 1);
        saveExtraQueueToStorage();
        updateExtraList();
    }

    // A listákat azonosító szerint kötjük, nem tömbindex szerint: a feldolgozó
    // bármikor levehet egy munkát a sor elejéről a kirajzolás és a kattintás
    // között, és akkor az index már mást jelölne.
    function updateExtraList() {
        if (!uiExtraList) return;
        uiExtraList.textContent = '';
        const shownJobs = extraJobs.slice(0, CONFIG.PANEL_PREVIEW);
        const hiddenCount = extraJobs.length - shownJobs.length;
        shownJobs.forEach(job => {
            const li = document.createElement('li');
            li.dataset.id = job.id;

            const nameEl = document.createElement('span');
            nameEl.className = 'lisa-job-name';
            nameEl.textContent = job.jobName;
            nameEl.title = `${job.jobName} — ID:${job.jobId}, x:${job.x}, y:${job.y}, ${formatDuration(job.duration)}`;

            const etaEl = document.createElement('span');
            etaEl.className = 'lisa-eta';

            const removeEl = document.createElement('span');
            removeEl.className = 'remove';
            removeEl.textContent = '✕';
            removeEl.title = 'Eltávolítás';
            removeEl.addEventListener('click', () => removeExtraJobById(job.id));

            li.appendChild(nameEl);
            li.appendChild(etaEl);
            li.appendChild(removeEl);
            uiExtraList.appendChild(li);
        });
        if (hiddenCount > 0) {
            const li = document.createElement('li');
            li.className = 'lisa-more-row';
            li.textContent = `… és még ${hiddenCount} munka`;
            li.title = `A lista ${CONFIG.PANEL_PREVIEW} elemet mutat, összesen ${extraJobs.length} várakozik.`;
            uiExtraList.appendChild(li);
        }
        if (uiExtraCount) uiExtraCount.textContent = extraJobs.length;
        updateExtraEtas();
        renderPendingInGameQueue();
    }

    // Csak az időpont-szövegeket írja át, a sorokat nem építi újra: így percenként
    // sokszor frissülhet anélkül, hogy a listát folyamatosan újrarajzolnánk.
    function updateExtraEtas() {
        if (!uiExtraList) return;
        const etas = computeEtas(extraJobs);
        etas.forEach((eta, i) => {
            const li = uiExtraList.children[i];
            if (!li || li.dataset.id !== eta.id) return;
            const el = li.querySelector('.lisa-eta');
            if (!el) return;
            el.textContent = formatEta(eta);
            const job = extraJobs[i];
            el.title = eta.travelMs >= 1000
                ? `Indulás ${clockHM(eta.start)}, vége ${clockHM(eta.finish)} — út: ${formatDuration(eta.travelMs / 1000)}, munka: ${formatDuration(job.duration)}`
                : `Indulás ${clockHM(eta.start)}, vége ${clockHM(eta.finish)} — munka: ${formatDuration(job.duration)}`;
            // Becslés jelzése, ha az utazási idő nem volt kiszámítható.
            el.style.opacity = eta.estimated ? '1' : '0.55';
        });
    }

    function updateHistoryList() {
        if (!uiHistoryList) return;

        // Kijelölés és darabszám megőrzése: egy háttérben rögzített munka
        // eddig újrarajzolással eltüntette a felhasználó félkész kiválasztását.
        const checked = new Set(
            Array.from(uiHistoryList.querySelectorAll('.hist-check')).filter(c => c.checked).map(c => c.dataset.id)
        );
        const counts = {};
        uiHistoryList.querySelectorAll('.lisa-count-input').forEach(i => { counts[i.dataset.id] = i.value; });

        uiHistoryList.textContent = '';
        jobHistory.forEach(job => {
            const li = document.createElement('li');

            const label = document.createElement('label');
            label.className = 'lisa-job-name';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'hist-check';
            cb.dataset.id = job.id;
            cb.checked = checked.has(job.id);
            const text = document.createElement('span');
            text.textContent = ` ${job.jobName} (ID:${job.jobId}, ${formatDuration(job.duration)})`;
            label.appendChild(cb);
            label.appendChild(text);

            const countWrap = document.createElement('span');
            const num = document.createElement('input');
            num.type = 'number';
            num.className = 'lisa-count-input';
            num.min = String(CONFIG.MIN_AMOUNT);
            num.max = String(CONFIG.MAX_AMOUNT);
            num.value = counts[job.id] || '1';
            num.dataset.id = job.id;
            countWrap.appendChild(num);

            li.appendChild(label);
            li.appendChild(countWrap);
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
        if (addingFromHistory || !uiHistoryList) return;

        const checks = Array.from(uiHistoryList.querySelectorAll('.hist-check')).filter(c => c.checked);
        if (checks.length === 0) {
            updateUIStatus('Válassz ki legalább egy munkát!');
            return;
        }
        addingFromHistory = true;
        addButton.disabled = true;
        setTimeout(() => { addingFromHistory = false; addButton.disabled = false; }, CONFIG.BUTTON_COOLDOWN);

        // Sorbaállításhoz nem kell hash, csak küldéshez – a processQueue úgyis
        // megvárja, amíg lesz. Egy hiányzó hash miatt eddig nem lehetett tervezni.
        let total = 0;
        checks.forEach(cb => {
            const job = jobHistory.find(j => j.id === cb.dataset.id);
            if (!job) return;
            const input = uiHistoryList.querySelector(`.lisa-count-input[data-id="${cb.dataset.id}"]`);
            const raw = parseInt(input && input.value, 10) || CONFIG.MIN_AMOUNT;
            const count = Math.min(Math.max(raw, CONFIG.MIN_AMOUNT), CONFIG.MAX_AMOUNT);
            total += addExtraJobs(job, count, job.jobName);
        });

        updateUI();
        if (total > 0) {
            updateUIStatus(`${total} munka az extra sorba (${extraJobs.length} várakozik).`);
            ensureProcessing();
        } else {
            updateUIStatus('Nem került új munka a sorba (a sor megtelt?).');
        }
    }

    // ============================================================
    // BOOT
    // ============================================================
    function boot() {
        // A vezetőt még a feldolgozás előtt eldöntjük, hogy egy második fül
        // ne kezdjen el rögtön küldeni.
        initTabSync();
        loadExtraQueueFromStorage();
        loadHistoryFromStorage();
        // Visszaírás az új kulcsra, különben a régiről minden induláskor
        // újra migrálnánk, és a normalizált alak sosem rögzülne.
        saveHistoryToStorage();
        injectUI();
        updateUI();
        updateUIStatus(isLeaderTab
            ? `Kész (sor: ${gameQueueLength()}/${gameQueueLimit()}).`
            : 'Passzív fül – egy másik, látható fül dolgozza fel a sort.');
        initAmountPatch();
        // A játék sora kívülről is változik (munka lejár, a felhasználó megszakít),
        // ezért rendszeresen ránézünk.
        lastSeenQueueLen = gameQueueLength();
        setInterval(watchGameQueue, CONFIG.WATCH_INTERVAL);
        if (extraJobs.length > 0) ensureProcessing();
    }

    function onDOMReady() {
        let attempts = 0;
        const checkDOM = setInterval(() => {
            attempts++;
            if (document.querySelector('#ui_workcontainer') || document.querySelector('#ui_bottomright')) {
                clearInterval(checkDOM);
                boot();
            } else if (attempts >= CONFIG.BOOT_MAX_ATTEMPTS) {
                // Enélkül a poll a lap élettartamáig futott, ha sosem jött elő a felület.
                clearInterval(checkDOM);
                console.warn('[Lisa] A játék felülete nem jelent meg, a script nem indul el.');
            }
        }, 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDOMReady);
    else onDOMReady();

    console.log('[Lisa] Modular v11.3 betöltve.');
})();
