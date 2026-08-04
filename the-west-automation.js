// ==UserScript==
// @name         The-West Modular Job Queue (Lisa v12.0)
// @namespace   http://tampermonkey.net/
// @version     12.0
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
        SAFETY_MARGIN_MS: 800,
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
        WATCH_INTERVAL: 1000,        // ilyen sűrűn nézzük a játék sorát és az időpontokat
        SLOT_FREED_DELAY: 400,       // felszabadult slot után ennyivel indítjuk a következőt
        MAX_WAIT_MS: 3600000,        // egy hibás date_done se tudja örökre megállítani
        TIMER_CHUNK: 60000,          // hosszú várakozást ekkora darabokban ébresztünk
        LEADER_HEARTBEAT: 5000,
        LEADER_TTL: 15000,           // ennyi néma szívverés után átvehető a feldolgozás
        MAX_HISTORY: 60,
        BOOT_MAX_ATTEMPTS: 60,
        WINDOW_ID: 'lisaExtraQueue',
        PANEL_WIDTH: 320,
        PANEL_HEIGHT: 210,           // kb. 4-5 munkasor látszik, a többi görgetéssel
        PANEL_TOP: 140,
        PANEL_RIGHT: 35,
        MAX_AMOUNT: 99,
        MIN_AMOUNT: 1,
        FALLBACK_QUEUE_LIMIT: 4,     // csak ha a játék TaskQueue-ja elérhetetlen
        DEFAULT_DURATION: 900,       // csak ha se a DOM-ból, se az előzményekből nem derül ki
        MAX_EXTRA_QUEUE: 500,
        JOBGROUP_MAX_DIST: 200,      // ennél messzebbi munkacsoportot nem fogadunk el helyszínnek
        GAME_QUEUE_PREVIEW: 6,       // ennyi várakozó munka látszik a játék sorában
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
    let pendingObserver = null;
    let observedHost = null;

    let uiExtraList, uiStatus, uiExtraCount, uiEmpty, uiPauseBtn;
    let uiQueueStatus, uiTotalEta;

    const OriginalXHR = window.XMLHttpRequest;

    // ============================================================
    //  3. SEGÉDFÜGGVÉNYEK
    // ============================================================
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const TAB_ID = generateId();

    // Egy percnél hosszabb időt sosem másodpercben mutatunk: a "~400 mp" olvashatatlan.
    // A perc FELFELÉ kerekít, mert a várakozásnál a "még 1 p" hasznosabb, mint a "0 p".
    function formatDuration(seconds) {
        const s = Math.max(0, Math.round(seconds || 0));
        if (s < 60) return `${s} mp`;
        const min = Math.ceil(s / 60);
        if (min < 60) return `${min} p`;
        const h = Math.floor(min / 60);
        const m = min % 60;
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
            /* A "+N" NEM külön sorban áll, hanem az utolsó megjelenített munka
               helyén, egy munkacsempe méretében -- így a sor-UI egy sorral
               alacsonyabb. A .task osztály hozza a játék csempeméretét, a
               min-width/height csak biztonsági háló, ha az mégis elmaradna. */
            #queuedTasks .lisa-pending-more {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 112px; min-height: 67px;
                box-sizing: border-box;
                vertical-align: top;
                cursor: pointer;
                font: bold 12px 'Georgia','Times New Roman',serif;
                color: #4a3b28;
                text-align: center;
                text-shadow: 0 1px 0 rgba(255,255,255,0.45);
            }
            #queuedTasks .lisa-pending-more:hover { color: #1e160e; }
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

    // A játék minden sorváltozáskor újraépíti a #queuedTasks tartalmát, és ilyenkor
    // a mi sorainkat is eldobja. A kétmásodperces figyelőre hagyva ez látható
    // villanás: a várakozók eltűnnek, majd visszajönnek. Ezért azonnal, ugyanabban
    // a körben pótoljuk őket.
    //
    // Nem okoz végtelen ciklust: csak akkor rajzolunk újra, ha az elválasztónk
    // HIÁNYZIK, a saját beszúrásunk után pedig már ott van.
    function observePendingHost() {
        const host = pendingHost();
        if (!host || host === observedHost) return;
        if (pendingObserver) pendingObserver.disconnect();
        observedHost = host;
        pendingObserver = new MutationObserver(() => {
            if (!extraJobs.length) return;
            if (host.querySelector('.lisa-pending-sep')) return;
            renderedPendingKey = '';
            renderPendingInGameQueue();
        });
        pendingObserver.observe(host, { childList: true });
    }

    function buildPendingItem(job, eta) {
        const item = document.createElement('span');
        item.className = 'task lisa-pending';   // a 'task' hozza a játék stílusát
        item.dataset.id = job.id;

        // A játék a sorban álló munkáknál az utazást NEM külön sorban mutatja
        // (az csak a futó munkánál van), hanem beleszámolja az időbe: egy 5 mp
        // úttal induló 15 mp-es munka 00:00:20-ként jelenik meg. Ugyanígy teszünk,
        // így ahol nincs helyváltás, ott magától csak a munkaidő látszik.
        const travelSec = eta ? Math.round(eta.travelMs / 1000) : 0;
        const time = document.createElement('div');
        time.className = 'taskTime';
        const p = document.createElement('p');
        p.textContent = formatClock(travelSec + (job.duration || 0));
        time.appendChild(p);

        const btns = document.createElement('div');
        btns.className = 'taskBtns';
        // Az út felezése még el nem indult munkára nem értelmezhető: a valódi
        // elemekkel azonos elrendezésért kirakjuk, de inaktív állapotban.
        const halve = document.createElement('div');
        halve.className = 'notAvailable taskHalveway';
        btns.appendChild(halve);
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
            ? (travelSec > 0
                ? `${job.jobName} — út: ${formatDuration(travelSec)} + munka: ${formatDuration(job.duration)}, várható: ${formatEta(eta)}`
                : `${job.jobName} — munka: ${formatDuration(job.duration)}, várható: ${formatEta(eta)}`)
            : `${job.jobName} — ${formatDuration(job.duration)} (várakozik)`;

        item.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            e.preventDefault();
            if (e.target.closest('.lisa-pending-abort')) removeExtraJobById(job.id);
        }, true);

        return item;
    }

    // Hány munkasor látszik és mennyi marad a "+N" csempére. Ha minden kifér, nincs
    // csempe; ha nem, akkor a csempe az UTOLSÓ hely(!) -- vagyis eggyel kevesebb
    // munka látszik, cserébe nem kell neki külön sor.
    function previewSplit(total, preview) {
        if (total <= preview) return { shown: total, hidden: 0 };
        return { shown: preview - 1, hidden: total - (preview - 1) };
    }

    function renderPendingInGameQueue() {
        injectPendingStyles();
        const host = pendingHost();
        if (!host) return;

        if (!extraJobs.length) {
            if (renderedPendingKey !== '') { clearPendingRows(host); renderedPendingKey = ''; }
            return;
        }

        const split = previewSplit(extraJobs.length, CONFIG.GAME_QUEUE_PREVIEW);
        const shown = extraJobs.slice(0, split.shown);
        const hidden = split.hidden;
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
            // A 'task' hozza a játék csempeméretét, hogy a "+N" pont egy munkahelyre
            // üljön. Kattintásra a saját panel jön elő -- ott a teljes lista látszik.
            more.className = 'task lisa-pending lisa-pending-more';
            more.textContent = `+${hidden}`;
            more.title = `${hidden} további munka a listában – kattints a teljes listáért`;
            // A .middle közvetlen click-kezelője elől ezt is elzárjuk (lásd fentebb).
            more.addEventListener('click', (e) => {
                e.stopImmediatePropagation();
                e.preventDefault();
                showLisaPanel();
            }, true);
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

    // A munkaablakban HÁROM időtartamsáv van (short/middle/long), és mindegyik
    // SAJÁT indítógombot tartalmaz. Alacsony szinten csak a 15 mp-es van
    // feloldva, ezért ott bármelyik kiolvasás jó eredményt ad -- 10. és 20.
    // szinttől viszont mindhárom aktív, és a "első nem letiltott sáv" mindig a
    // 15 mp-eset adná vissza, függetlenül attól, melyik gombra kattintottak.
    // Ezért az időtartam abból a sávból jön, amelyikben a MEGNYOMOTT gomb van.
    function durationFromBar(bar) {
        if (!bar) return null;
        // A data-base kulcsai (short/middle/long) pontosan egyeznek a
        // JobList.getDurations() kulcsaival, így nem kell szöveget értelmezni.
        try {
            const base = bar.dataset && bar.dataset.base;
            const all = (window.JobList && typeof JobList.getDurations === 'function') ? JobList.getDurations() : null;
            if (base && all && all[base] && all[base].duration > 0) return all[base].duration;
        } catch(e) {}
        const el = bar.querySelector('.job_value_duration');
        return el ? parseDurationText(el.textContent) : null;
    }

    function parseJobWindow(windowEl, startBtn) {
        const classList = windowEl.className;
        const match = classList.match(/job-(\d+)-(\d+)-(\d+)/);
        if (!match) return null;
        const x = parseInt(match[1], 10);
        const y = parseInt(match[2], 10);
        const jobId = parseInt(match[3], 10);

        const clickedBar = startBtn ? startBtn.closest('.job_durationbar') : null;
        let duration = durationFromBar(clickedBar)
            || durationFromBar(windowEl.querySelector('.job_durationbar:not(.disabled)'));

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

        const jobData = gameReady() ? parseJobWindow(jobWindow, startBtn) : null;
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

    // ------------------------------------------------------------
    //  Gyorsindító nyilak a térképen
    // ------------------------------------------------------------
    // A térképen egy munkacsoportra kattintva körben szétnyílnak az egyes munkák
    // ikonjai (.job.job-{jobId}), és fölé húzva megjelenik a gyorsindító nyíl
    // (.instantwork-short | -middle | -long). Ez megkerüli a nagy munkaablakot,
    // ezért ugyanúgy el kell kapnunk, különben az így indított munka beelőzne a
    // már sorban állók elé.
    //
    // A .job elem közvetlenül a #map gyereke, koordinátát nem hordoz. A szétnyílt
    // kör alatt viszont ott marad a csoport ikonja a posx-/posy- osztályokkal,
    // pontosan a kör közepén: mérve 0 px-re a középponttól, míg a következő
    // csoport 528 px-re volt. Ezért a helyszínt a legközelebbi csoportból vesszük,
    // biztonsági távolsághatárral.
    function nearestJobGroup(el) {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        let best = null;
        for (const g of document.querySelectorAll('.jobgroup')) {
            const m = String(g.className).match(/posx-(\d+)\s+posy-(\d+)/);
            if (!m) continue;
            const gr = g.getBoundingClientRect();
            if (!gr.width) continue;
            const dist = Math.hypot(gr.x + gr.width / 2 - cx, gr.y + gr.height / 2 - cy);
            if (!best || dist < best.dist) best = { x: parseInt(m[1], 10), y: parseInt(m[2], 10), dist };
        }
        return (best && best.dist <= CONFIG.JOBGROUP_MAX_DIST) ? best : null;
    }

    document.addEventListener('click', function(e) {
        const arrow = e.target.closest('[class*="instantwork-"]');
        if (!arrow || !gameReady()) return;

        const base = (String(arrow.className).match(/instantwork-(short|middle|long)/) || [])[1];
        const jobEl = arrow.closest('[class*="job-"]');
        const idMatch = jobEl && String(jobEl.className).match(/\bjob-(\d+)\b/);
        if (!base || !idMatch) return;

        const jobId = parseInt(idMatch[1], 10);
        const spot = nearestJobGroup(jobEl);
        let duration = null;
        try {
            const all = JobList.getDurations();
            duration = all && all[base] && all[base].duration;
        } catch(err) {}

        // Ha bármi hiányzik, NEM nyúlunk hozzá: menjen a játék saját útján.
        // Rossz koordinátával indítani rosszabb, mint nem elkapni a kattintást.
        if (!spot || !duration) {
            console.warn('[Lisa] Gyorsindítás: nincs meg a helyszín vagy az időtartam, marad a játéké.');
            return;
        }

        // A #map delegált kezelője a .job és .instantwork elemekre is figyel,
        // ezért itt kell megállítani, különben a játék is elindítaná a munkát.
        e.stopImmediatePropagation();
        e.preventDefault();

        let name = `Job #${jobId}`;
        try { const j = JobList.getJobById(jobId); if (j && j.name) name = j.name; } catch(err) {}

        const jobData = { jobId, x: spot.x, y: spot.y, duration, taskType: 'job' };
        addExtraJobs(jobData, 1, name);
        addJobToHistory({ ...jobData, jobName: name });
        updateUI();
        updateUIStatus(`${name} sorba állítva (${extraJobs.length} várakozik).`);
        ensureProcessing();
    }, true);

    // ------------------------------------------------------------
    //  "Összes munka törlése" -- a várakozókat is törli
    // ------------------------------------------------------------
    // A gomb megerősítő dialógust nyit ("Az összes munka törlése", Igen/Nem), és
    // csak jóváhagyás után ürít. Ilyenkor a szándék egyértelmű: álljon meg minden.
    // Ha csak a játék sora ürülne, a script másfél másodperc múlva újratöltené a
    // slotokat, azaz visszacsinálná a törlést -- és újra elköltené a megszakítással
    // visszakapott energiát.
    //
    // Nem a gombra lépünk, hanem a MEGERŐSÍTÉSRE: a dialógus valamelyik gombja
    // után rövid ablakban figyeljük, tényleg kiürült-e a sor. Így a "Nem" nem
    // töröl semmit, és nem függünk a dialógus szövegétől sem.
    function clearExtraAfterCancelAll() {
        if (!extraJobs.length) return;
        const count = extraJobs.length;
        extraJobs = [];
        saveExtraQueueToStorage();
        updateUI();
        updateUIStatus(`Minden munka törölve – ${count} várakozó is.`);
        console.log(`[Lisa] Összes törlése megerősítve: ${count} várakozó munka törölve.`);
    }

    function watchCancelAllConfirm() {
        let waited = 0;
        const findDialog = setInterval(() => {
            waited++;
            const dlg = document.querySelector('.tw2gui_dialog');
            if (!dlg) {
                if (waited > 15) clearInterval(findDialog);
                return;
            }
            clearInterval(findDialog);
            dlg.addEventListener('click', (ev) => {
                if (!ev.target.closest('.tw2gui_button')) return;
                const before = gameQueueLength();
                if (!before) return;
                let ticks = 0;
                const confirmed = setInterval(() => {
                    ticks++;
                    if (gameQueueLength() === 0) {
                        clearInterval(confirmed);
                        clearExtraAfterCancelAll();
                    } else if (ticks > 15) {
                        clearInterval(confirmed);   // "Nem" -- a sor megmaradt
                    }
                }, 200);
            }, true);
        }, 200);
    }

    document.addEventListener('click', function(e) {
        // Csak megfigyelünk, a játék gombja a szokásos módon működik tovább.
        if (e.target.closest('#cancelAllInQueue')) watchCancelAllConfirm();
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
                updateUIStatus(`Sor tele (${gameQueueLength()}/${gameQueueLimit()}) – ~${formatDuration(waitMs / 1000)}`);
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
                    updateUIStatus('Kész – minden munka elindítva.');
                    return;
                }
                if (freeSlots() > 0) {
                    updateUIStatus(`${accepted} elindítva, még ${extraJobs.length} vár (sor: ${gameQueueLength()}/${gameQueueLimit()})`);
                    scheduleNextJob(rand(CONFIG.MIN_SEND_GAP, CONFIG.MIN_SEND_GAP + 1000));
                } else {
                    const waitMs = waitUntilFreeSlotMs();
                    updateUIStatus(`${accepted} elindítva, még ${extraJobs.length} – következő slot ~${formatDuration(waitMs / 1000)} múlva`);
                    scheduleNextJob(waitMs);
                }
                return;
            }

            // A játék egyet sem fogadott el. A lista érintetlen, csak várunk.
            const job = extraJobs[0];
            job.retries = (job.retries || 0) + 1;
            const waitMs = waitUntilFreeSlotMs();
            console.warn(`[Lisa] A játék nem fogadta el: ${job.jobName} (${job.retries}. próba)`);
            updateUIStatus(`${job.jobName} nem indult el – újra ~${formatDuration(waitMs / 1000)} múlva (${job.retries})`);

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
        ensureMenuButton();
        updateQueueBadge();
        updateExtraEtas();
        observePendingHost();
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
            }
        });
    }

    // --- Menüsor gomb kezelése ---
    // ============================================================
    //  A PANEL: A JÁTÉK SAJÁT ABLAKKERETÉBEN
    // ============================================================
    // A wman a játék ablakkezelője: wman.open(uid, cím) valódi játékablakot ad
    // kerettel, címsorral, minimalizálás/bezárás gombokkal és fogd-és-vidd
    // mozgatással. Így a panel ugyanúgy néz ki és viselkedik, mint bármelyik
    // másik ablak, saját keret-utánzat helyett.
    //
    // Két háttérréteget igazítani kell, mert magas ablaknál elfogynak:
    //  - .tw2gui_window_inset hordozza a pergament (natúr 721x420, no-repeat,
    //    balra-lentre igazítva), efölé nyúlva üresen maradna a teteje;
    //  - .tw2gui_inner_window_bg2 a jobb oldali 32x420-as széldísz, ezt csak
    //    FÜGGŐLEGESEN szabad nyújtani, különben sötét sávvá kenődik szét.
    // Mindkét felülírás a saját ablakunk osztályára van szűkítve.
    function injectPanelStyles() {
        if (document.getElementById('lisa-panel-style')) return;
        const st = document.createElement('style');
        st.id = 'lisa-panel-style';
        st.textContent = `
            #lisa-body { display: flex; flex-direction: column; height: 100%; font-family: Georgia,'Times New Roman',serif; }
            /* A státuszsor két részre oszlik: balra az üzenet, jobbra a teljes lista
               várható vége. Így az összesítés nem eszik el egy újabb sornyi magasságot. */
            #lisa-status {
                display: flex; align-items: baseline; gap: 6px; flex: 0 0 auto;
                font: italic 11px Georgia,serif; color: #4a3b28; padding: 1px 20px 3px 4px;
            }
            #lisa-status-text { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #lisa-total-eta {
                flex: 0 0 auto; font-style: normal; font-weight: bold; color: #3b2f1e;
                font-variant-numeric: tabular-nums; white-space: nowrap;
            }
            /* A keret bal és jobb oldalán sötét széldísz fut. A listát beljebb húzzuk,
               hogy se a szöveg, se az eltávolító ✕ ne lógjon rá. */
            #lisa-scroll {
                flex: 1 1 auto; overflow-y: auto; overflow-x: hidden;
                margin: 0 20px 0 2px;
                border-top: 1px solid rgba(90,70,45,0.35);
                border-bottom: 1px solid rgba(90,70,45,0.35);
            }
            #lisa-scroll::-webkit-scrollbar { width: 8px; }
            #lisa-scroll::-webkit-scrollbar-track { background: rgba(90,70,45,0.12); }
            #lisa-scroll::-webkit-scrollbar-thumb { background: #8a7048; border-radius: 4px; border: 1px solid #6b5636; }
            #lisa-scroll::-webkit-scrollbar-thumb:hover { background: #a3855a; }
            #lisa-extra-list { list-style: none; margin: 0; padding: 0; }
            #lisa-extra-list li {
                display: flex; align-items: center; justify-content: space-between;
                padding: 2px 4px; border-bottom: 1px dotted rgba(90,70,45,0.35);
                font-size: 12px; color: #3b2f1e;
            }
            #lisa-extra-list li:nth-child(even) { background: rgba(120,95,60,0.07); }
            .lisa-job-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .lisa-eta { font-size: 10px; color: #6b5a42; white-space: nowrap; margin-left: 6px; font-variant-numeric: tabular-nums; }
            #lisa-extra-list .remove { color: #a03020; cursor: pointer; font-weight: bold; margin-left: 8px; font-size: 13px; line-height: 1; }
            #lisa-extra-list .remove:hover { color: #d04030; }
            #lisa-empty { padding: 8px 4px; font: italic 11px Georgia,serif; color: #6b5a42; text-align: center; }
            #lisa-toolbar {
                flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
                padding: 4px 20px 0 2px; font-size: 11px; color: #4a3b28;
            }
            #lisa-toolbar button {
                font: 11px Georgia,serif; color: #f0e4c6; cursor: pointer;
                background: linear-gradient(#6b5636,#4a3b28);
                border: 1px solid #2e2416; border-radius: 3px; padding: 2px 8px;
                text-shadow: 0 1px 1px #000;
            }
            #lisa-toolbar button:hover { background: linear-gradient(#8a7048,#5c4a30); }
            #lisa-menu-btn {
                display: flex; align-items: center; justify-content: center;
                width: 29px; height: 29px; margin: 2px;
                font: bold 12px Georgia,serif; color: #e6d5b8; cursor: pointer;
                background: rgba(70,55,35,0.9); border: 1px solid #b89a6b; border-radius: 3px;
            }
            #lisa-menu-btn:hover { background: #b89a6b; color: #1e160e; }
        `;
        document.head.appendChild(st);
    }

    function panelWindow() {
        try { return wman.getById(CONFIG.WINDOW_ID) || null; } catch(e) { return null; }
    }

    // Az ablak szándékosan alacsony; ami nem fér ki, az görgetéssel érhető el.
    // Ennél magasabbra nem érdemes menni, mert a pergamen háttér natúr magassága
    // 420 px, efölé nyúlva a keret teteje üresen maradna.
    function panelHeight() {
        return Math.max(170, Math.min(CONFIG.PANEL_HEIGHT, window.innerHeight - 180));
    }

    function applyPanelGeometry(win) {
        try { win.setSize(CONFIG.PANEL_WIDTH, panelHeight()); } catch(e) {}
        const el = document.querySelector('.' + CONFIG.WINDOW_ID);
        if (!el) return;
        // A korábbi panel helye: jobb felső sarok, a térkép alatt.
        el.style.left = Math.max(0, window.innerWidth - CONFIG.PANEL_WIDTH - CONFIG.PANEL_RIGHT) + 'px';
        el.style.top = CONFIG.PANEL_TOP + 'px';
    }

    function buildPanelContent(win) {
        const pane = win.getContentPane();
        const el = pane && pane.jquery ? pane[0] : pane;
        if (!el) return false;

        el.innerHTML = `
            <div id="lisa-body">
                <div id="lisa-status">
                    <span id="lisa-status-text">Inicializálás...</span>
                    <span id="lisa-total-eta"></span>
                </div>
                <div id="lisa-scroll"><ul id="lisa-extra-list"></ul><div id="lisa-empty"></div></div>
                <div id="lisa-toolbar">
                    <button id="lisa-pause-btn" title="Szünet / Folytatás">Szünet</button>
                    <span>Sor: <span id="lisa-queue-status">–</span> · Várakozó: <span id="lisa-extra-count">0</span></span>
                    <button id="lisa-clear-extra" title="A teljes várakozó lista törlése">Törlés</button>
                </div>
            </div>`;

        uiStatus = el.querySelector('#lisa-status-text');
        uiTotalEta = el.querySelector('#lisa-total-eta');
        uiExtraList = el.querySelector('#lisa-extra-list');
        uiExtraCount = el.querySelector('#lisa-extra-count');
        uiQueueStatus = el.querySelector('#lisa-queue-status');
        uiEmpty = el.querySelector('#lisa-empty');
        uiPauseBtn = el.querySelector('#lisa-pause-btn');

        uiPauseBtn.addEventListener('click', togglePause);
        el.querySelector('#lisa-clear-extra').addEventListener('click', clearExtraQueue);
        return true;
    }

    // Idempotens. A wman.close() teljesen megszünteti az ablakot (a getById is
    // üresen tér vissza), és az újranyitás ÜRES tartalompanelt ad -- ezért a
    // tartalmat mindig újra fel kell építeni, ha hiányzik.
    function ensurePanel() {
        injectPanelStyles();
        let win = panelWindow();
        if (!win || !document.querySelector('.' + CONFIG.WINDOW_ID)) {
            try {
                win = wman.open(CONFIG.WINDOW_ID, 'Extra Queue');
            } catch(e) {
                console.error('[Lisa] Nem sikerült megnyitni a játékablakot:', e);
                return null;
            }
            if (!win) return null;
            applyPanelGeometry(win);
        }
        if (!document.getElementById('lisa-body')) {
            if (!buildPanelContent(win)) return null;
            updateUI();
            refreshIdleStatus();
        }
        return win;
    }

    // Újranyitás után a státuszsor a helyőrzőt mutatná; írjuk ki a valós állapotot.
    function refreshIdleStatus() {
        updateUIStatus(
            paused ? 'Szüneteltetve'
            : !isLeaderTab ? 'Passzív fül – egy másik, látható fül dolgozza fel a sort.'
            : extraJobs.length ? `${extraJobs.length} munka várakozik.`
            : 'Kész.');
    }

    function showLisaPanel() {
        const win = ensurePanel();
        try { if (win) win.bringToTop(); } catch(e) {}
    }

    // Visszanyitó gomb a menüsorban, a fogaskerék alatt -- a wman ✕-e teljesen
    // bezárja az ablakot, e nélkül nem lenne út vissza.
    function ensureMenuButton() {
        if (document.getElementById('lisa-menu-container')) return;
        const menubar = document.getElementById('ui_menubar');
        if (!menubar) return;
        const container = document.createElement('div');
        container.className = 'ui_menucontainer';
        container.id = 'lisa-menu-container';
        const link = document.createElement('div');
        link.className = 'menulink';
        link.id = 'lisa-menu-btn';
        link.title = 'Extra Queue megnyitása';
        link.textContent = 'EQ';
        link.addEventListener('click', showLisaPanel);
        const bottom = document.createElement('div');
        bottom.className = 'menucontainer_bottom';
        container.appendChild(link);
        container.appendChild(bottom);
        menubar.appendChild(container);
    }

    function updateUI() { updateExtraList(); updateQueueBadge(); }

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
        extraJobs.forEach(job => {
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
        if (uiEmpty) uiEmpty.textContent = extraJobs.length ? '' : 'Nincs várakozó munka.';
        if (uiExtraCount) uiExtraCount.textContent = extraJobs.length;
        updateExtraEtas();
        renderPendingInGameQueue();
    }

    // A státuszsor jobb szélén a TELJES lista várható vége: a lánc utolsó munkájának
    // befejezése. Ez a leggyakoribb kérdés ("mikorra végez az egész?"), és az
    // egyenkénti időpontokból fejben összeadni nem lehet -- az utazás is benne van.
    function updateTotalEta(etas) {
        if (!uiTotalEta) return;
        if (!etas.length) {
            uiTotalEta.textContent = '';
            uiTotalEta.title = '';
            return;
        }
        const last = etas[etas.length - 1];
        uiTotalEta.textContent = `Vége ${clockHM(last.finish)}${dayOffset(last.finish)}`;
        const workSec = extraJobs.reduce((s, j) => s + (j.duration || 0), 0);
        const travelSec = etas.reduce((s, e) => s + e.travelMs / 1000, 0);
        uiTotalEta.title =
            `A teljes lista (${extraJobs.length} munka) várható vége: ${clockHM(last.finish)}${dayOffset(last.finish)}\n`
            + `Hátralévő idő: ${formatDuration((last.finish - Date.now()) / 1000)}\n`
            + `Ebből munka: ${formatDuration(workSec)}, út: ${formatDuration(travelSec)}`;
        // Ha az utazási idő nem volt kiszámítható, a becslés hiányos -- jelezzük.
        uiTotalEta.style.opacity = last.estimated ? '1' : '0.55';
    }

    // Csak az időpont-szövegeket írja át, a sorokat nem építi újra: így percenként
    // sokszor frissülhet anélkül, hogy a listát folyamatosan újrarajzolnánk.
    function updateExtraEtas() {
        if (!uiExtraList) return;
        const etas = computeEtas(extraJobs);
        updateTotalEta(etas);
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

    function togglePause() {
        paused = !paused;
        if (uiPauseBtn) uiPauseBtn.textContent = paused ? 'Folytatás' : 'Szünet';
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
        updateUI();
        updateUIStatus('Extra sor törölve.');
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
        ensurePanel();
        ensureMenuButton();
        updateUI();
        updateUIStatus(isLeaderTab
            ? 'Kész.'
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

    console.log('[Lisa] Modular v12.0 betöltve.');
})();
