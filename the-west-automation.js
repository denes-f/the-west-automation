// ==UserScript==
// @name         The-West Modular Job Queue (Lisa v12.4)
// @namespace   http://tampermonkey.net/
// @version     12.4
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
        MAX_REJECTIONS: 10,          // ennyi SZERVEROLDALI elutasítás után adjuk fel
        REJECT_BACKOFF_MS: 20000,    // az első elutasítás után ennyit várunk
        REJECT_BACKOFF_MAX: 600000,  // ...majd duplázva, legfeljebb ennyit
        ADD_RESPONSE_TTL: 20000,     // ennél régebbi köteghez már nem párosítunk választ
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
        KEEP_AWAKE: true,            // képernyőzár és fülfagyasztás elleni védelem
        MOTIVATION_WARN: 75,         // ekkora (vagy kisebb) motivációnál figyelmeztetünk
        JOB_INFO_TTL: 300000,        // ennyi ideig hisszük el a motivációt/energiaköltséget
        AUTO_SLEEP: true,            // energiahiánynál felajánljuk az alvást
        QUEUE_MANUAL_SLEEP: true,    // a hotelben indított alvás is a saját sorba megy
        SLEEP_DECLINE_MS: 1800000,   // "Nem" után ennyi ideig nem kérdezünk újra
        SLEEP_REGEN_ESTIMATE: 0.125, // csak a KIJELZETT alvásidő becsléséhez (mért érték)
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
    let inFlightBatch = null;        // amit épp átadtunk a játéknak, a válaszig
    let lastForecast = [];           // munkánkénti energia/motiváció előrejelzés
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

    // Egy kérés MINDEN munkája, sorrendben. A válasz tasks[] tömbje indexre
    // képeződik a kérés munkáira, ezért a párosításhoz a teljes lista kell.
    function extractTasksFromBody(body) {
        const params = parseBodyParams(body);
        const byIdx = {};
        for (const k in params) {
            const m = k.match(/\[(\d+)\]\[(\w+)\]$/);
            if (!m) continue;
            (byIdx[m[1]] = byIdx[m[1]] || {})[m[2]] = params[k];
        }
        return Object.keys(byIdx)
            .sort((a, b) => a - b)
            .map(i => {
                const id = parseInt(byIdx[i].jobId, 10);
                return {
                    jobId: isNaN(id) ? null : id,      // az alvásnak nincs munkaazonosítója
                    x: parseInt(byIdx[i].x, 10) || 0,
                    y: parseInt(byIdx[i].y, 10) || 0,
                    duration: parseInt(byIdx[i].duration, 10) || CONFIG.DEFAULT_DURATION,
                    taskType: byIdx[i].taskType || 'job',
                };
            })
            .filter(t => t.jobId !== null || t.taskType !== 'job');
    }

    // A válasz tasks[i] eleme a kérés i. munkájáról szól, és vagy {task:{...}},
    // vagy {error:true,msg:"..."}. A hibásakat adja vissza a hozzájuk tartozó
    // munkaobjektummal. Felső szintű hiba esetén az EGÉSZ köteg elbukott.
    function rejectedFromAddResponse(batch, data) {
        if (!batch || !batch.length || !data) return [];
        if (!Array.isArray(data.tasks)) {
            return data.error ? batch.map(job => ({ job, msg: data.msg || '' })) : [];
        }
        const out = [];
        data.tasks.forEach((entry, i) => {
            if (batch[i] && entry && entry.error) out.push({ job: batch[i], msg: entry.msg || '' });
        });
        return out;
    }

    // A válasz csak akkor a MI kötegünkről szól, ha a kérés munkái pontosan a
    // mieink, ugyanabban a sorrendben. Enélkül a felhasználó saját, egyidejű
    // indítása is a mi listánkat módosítaná.
    function addResponseMatchesBatch(bodyTasks, batch) {
        return !!batch && bodyTasks.length === batch.length
            && bodyTasks.every((t, i) => {
                const mine = batch[i];
                // Az alvásnak nincs munkaazonosítója és időtartama a kérésben,
                // ott a típus az egyetlen fogódzó.
                if ((mine.taskType || 'job') !== 'job') return t.taskType === mine.taskType;
                return t.jobId === mine.jobId && t.duration === mine.duration;
            });
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
            // A játék képlete kiolvasva (GameMap.calcWayTime):
            //   idő = euklideszi táv * Game.travelSpeed * Character.speed
            // Vagyis a másodperc/egység arány KÖZVETLENÜL is megvan, próbahívás nélkül --
            // és a ló meg a sebesség-buffok a Character.speed-ben már benne vannak.
            const g = window.Game, ch = window.Character;
            if (g && ch && typeof g.travelSpeed === 'number' && typeof ch.speed === 'number') {
                const rate = g.travelSpeed * ch.speed;
                if (isFinite(rate) && rate > 0) return rate;
            }
            // Tartalék: ha a játék belső mezői egyszer átneveződnének, mérünk.
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
                let done = e && e.data && e.data.date_done;
                // Az alvás mindig 8 órára megy be, de mi megszakítjuk, amint az
                // energia feltöltődött -- a láncot a VÁRHATÓ ébredéshez kötjük,
                // különben minden utána jövő munka nyolc órával későbbre csúszna.
                if (e && e.type === 'sleep' && typeof done === 'number') {
                    const wake = now + msUntilEnergy(sleepTargetEnergy(e.data && e.data.room));
                    done = Math.min(done, wake);
                }
                if (typeof done === 'number' && done > 0 && (!tail || done > tail.at)) {
                    // Az alvásnál a helyszín a data-ban van, nem a post-ban.
                    const p = (e.post && typeof e.post.x === 'number') ? e.post
                            : (e.data && typeof e.data.x === 'number') ? e.data : null;
                    tail = { at: done, pos: p ? { x: p.x, y: p.y } : null };
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

    // ------------------------------------------------------------
    //  Energia és motiváció
    // ------------------------------------------------------------
    // Mindkettőt a játéktól kérdezzük, nem modellezzük:
    //  - a munkánkénti energiaköltség és a motiváció egyetlen, OLVASÓ hívásból
    //    jön (Ajax.remoteCallMode "job"/"job"), ami nem költ energiát;
    //  - az energia jövőbeli értékét a játék saját képletével számoljuk.
    // Semmit nem égetünk be: a 3/óra regeneráció, az 1/5/12 energiaköltség és a
    // motivációlépcső mind a szervertől jön, így a prémiumok és a jövőbeli
    // egyensúlyozás magától érvényesül.
    const jobInfoCache = new Map();     // jobId -> { motivation, costs, at }
    const jobInfoPending = new Set();

    function serverNowSec() {
        try {
            if (window.Game && typeof Game.getServerTime === 'function') return Game.getServerTime();
        } catch(e) {}
        return Date.now() / 1000;
    }

    // A szerver- és a helyi óra eltérése csekély (mérve 1 mp), de a mienk helyi
    // ezredmásodperc, az energiahorgony viszont szerver-másodperc.
    function toServerSec(ms) {
        return ms / 1000 + (serverNowSec() - Date.now() / 1000);
    }

    // A játék saját képlete (Game.tick4Character), változtatás nélkül. A
    // (Character.energy, Character.energyDate) pár mindig összetartozik: a
    // setEnergy minden változáskor újraállítja a dátumot is. Alvás alatt a játék
    // egyszerűen megemeli az energyRegen-t (mérve 0,03 -> 0,125), ezért ugyanez
    // a képlet az alvás alatti töltődésre is érvényes.
    function energyAt(ms) {
        const c = window.Character;
        if (!c || typeof c.energy !== 'number') return null;
        const max = c.maxEnergy || 100;
        const regen = typeof c.energyRegen === 'number' ? c.energyRegen : 0;
        const anchor = typeof c.energyDate === 'number' ? c.energyDate : serverNowSec();
        const secs = Math.max(0, toServerSec(ms) - anchor);
        return Math.min(max, Math.floor(c.energy + max * regen * secs / 3600));
    }

    // Mennyi idő, amíg az energia elér egy szintet. A játék képletét fordítjuk
    // meg, tehát ugyanaz a regeneráció (és alvás alatt ugyanúgy a megemelt) érték.
    function msUntilEnergy(target) {
        const c = window.Character;
        if (!c || typeof c.energy !== 'number') return CONFIG.MIN_SEND_GAP;
        const max = c.maxEnergy || 100;
        // A maximum fölé sosem jutunk: egy ilyen célra várni örökös várakozás lenne.
        target = Math.min(target, max);
        if (c.energy >= target) return 0;
        const regen = typeof c.energyRegen === 'number' ? c.energyRegen : 0;
        const perHour = max * regen;
        if (perHour <= 0) return CONFIG.MAX_WAIT_MS;      // nem regenerálódik: ne pörögjünk
        return Math.ceil((target - c.energy) / perHour * 3600) * 1000;
    }

    function jobEnergyCost(job) {
        const info = jobInfoCache.get(job.jobId);
        const cost = info && info.costs ? info.costs[job.duration] : undefined;
        return typeof cost === 'number' ? cost : null;   // amíg nem tudjuk, nem találgatunk
    }

    function jobMotivation(jobId) {
        const info = jobInfoCache.get(jobId);
        return info && typeof info.motivation === 'number' ? info.motivation : null;
    }

    // Munkánként egy olvasó lekérdezés, TTL-lel. Energiát nem költ, a sor
    // állapotát nem érinti -- kizárólag a kijelzéshez kell.
    function requestJobInfo(job) {
        const id = job.jobId;
        if (!id || jobInfoPending.has(id)) return;
        const cached = jobInfoCache.get(id);
        if (cached && Date.now() - cached.at < CONFIG.JOB_INFO_TTL) return;
        if (!window.Ajax || typeof Ajax.remoteCallMode !== 'function') return;
        jobInfoPending.add(id);
        try {
            Ajax.remoteCallMode('job', 'job', { jobId: id, x: job.x, y: job.y }, (json) => {
                jobInfoPending.delete(id);
                if (!json || json.error) return;
                const costs = {};
                (json.durations || []).forEach(d => {
                    if (d && typeof d.duration === 'number') costs[d.duration] = d.cost;
                });
                jobInfoCache.set(id, { motivation: json.motivation, costs, at: Date.now() });
                updateExtraEtas();
            });
        } catch(e) {
            jobInfoPending.delete(id);
        }
    }

    // A LÁTHATÓ munkákra kérdezünk rá, nem az egész listára: 99 azonos munkánál
    // is egyetlen kérés megy ki, mert a gyorsítótár kulcsa a munka azonosítója.
    function refreshJobInfo(jobs) {
        const seen = new Set();
        for (const job of jobs) {
            if (seen.has(job.jobId)) continue;
            seen.add(job.jobId);
            requestJobInfo(job);
        }
    }

    // A játék sorában álló munkák a mieink ELŐTT fejeződnek be, tehát az ő
    // motivációcsökkenésük már a mi első munkánkat is érinti.
    function motivationAlreadyCommitted() {
        const out = {};
        if (!gameReady()) return out;
        for (const t of window.TaskQueue.queue) {
            const p = t && t.post;
            if (!p || typeof p.jobId !== 'number') continue;
            const cost = jobEnergyCost({ jobId: p.jobId, duration: p.duration });
            if (cost !== null) out[p.jobId] = (out[p.jobId] || 0) + cost;
        }
        return out;
    }

    // Munkánkénti előrejelzés. A motiváció a munka BEFEJEZÉSEKOR csökken a munka
    // energiaköltségével, az energia viszont már a játék sorába kerüléskor
    // levonódik -- a kettőt tehát külön kell számolni.
    function computeForecast(jobs, etas, opts) {
        const committed = Object.assign({}, opts.priorMotivationCost || {});
        let energyUsed = 0;
        return jobs.map((job, i) => {
            const start = etas[i] ? etas[i].start : Date.now();
            const cost = opts.costOf(job);
            const base = opts.motivationOf(job.jobId);
            const motivation = (typeof base === 'number')
                ? Math.round(base * 100) - (committed[job.jobId] || 0)
                : null;
            const predicted = opts.energyAt(start);
            const energyBefore = predicted === null ? null : predicted - energyUsed;
            const energyAfter = (energyBefore === null || cost === null) ? null : energyBefore - cost;
            if (cost !== null) {
                energyUsed += cost;
                committed[job.jobId] = (committed[job.jobId] || 0) + cost;
            }
            return {
                id: job.id,
                cost,
                motivation,
                energyBefore,
                energyAfter,
                lowMotivation: motivation !== null && motivation <= opts.motivationWarn,
                notEnoughEnergy: energyBefore !== null && cost !== null && energyBefore < cost,
            };
        });
    }

    // ------------------------------------------------------------
    //  Előrejelzett energiasáv a karakter energiasávja alatt
    // ------------------------------------------------------------
    // A játék sávja egyetlen div, a töltöttséget a háttérsprite eltolása adja.
    // A képletet a játékból olvastuk ki (WestUi.updateEnergy), így a saját
    // sávunk pixelre ugyanúgy néz ki -- csak halványabb, mert ez jóslat.
    const ENERGY_BAR_WIDTH = 137;

    function energySpriteY() {
        try {
            return (window.Premium && Premium.hasBonus('regen')) ? -26 : -13;
        } catch(e) { return -13; }
    }

    // A játék calcWidth-e, változtatás nélkül.
    function energyBarFill(value, max, width) {
        return Math.min(width, Math.max(0, Math.ceil(width * (value / max * 100) / 100)));
    }

    function ensureEnergyForecastBar() {
        const real = document.querySelector('#ui_character_container > .energy_bar');
        if (!real) return null;
        let bar = document.getElementById('lisa-energy-forecast');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'lisa-energy-forecast';
            // A játék osztályai hozzák a spritot és a tipográfiát; a
            // hasMousePopup-ot NEM vesszük át, mert az a játék sávjáé.
            bar.className = 'status_bar energy_bar';
            real.parentElement.appendChild(bar);
        }
        // Ugyanaz a térköz, ahogy az energiasáv követi az életsávot (15 px).
        bar.style.position = 'absolute';
        bar.style.left = getComputedStyle(real).left;
        bar.style.top = (real.offsetTop + 15) + 'px';
        bar.style.opacity = '0.72';
        bar.style.cursor = 'help';
        return bar;
    }

    // A lista VÉGÉN várható energia. Dinamikus: a jóslás a regenerációt is
    // tartalmazza, tehát ha közben töltődik, a sáv magától követi.
    function updateEnergyForecastBar() {
        const bar = ensureEnergyForecastBar();
        if (!bar) return;
        const c = window.Character;
        const max = (c && c.maxEnergy) || 100;
        const last = lastForecast.length ? lastForecast[lastForecast.length - 1] : null;
        const value = last && typeof last.energyAfter === 'number' ? last.energyAfter : null;

        // Üres listánál vagy ismeretlen költségnél nincs mit jósolni.
        if (value === null || !extraJobs.length) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'block';
        const shown = Math.max(0, Math.min(max, value));
        bar.style.backgroundPosition =
            `${-ENERGY_BAR_WIDTH + energyBarFill(shown, max, ENERGY_BAR_WIDTH)}px ${energySpriteY()}px`;
        bar.textContent = `${shown} / ${max}`;
        bar.title = `Várható energia a lista végén (${extraJobs.length} munka után): ${value}`
            + (value < 0 ? `\nEnnyi energia nem lesz meg – ${-value} hiányzik.` : '');
        // Ha a lista elfogyasztaná az összes energiát, az szembetűnő legyen.
        bar.style.boxShadow = value <= 0 ? 'inset 0 0 0 1px #a03020' : '';
    }

    function forecastForExtraQueue(jobs, etas) {
        return computeForecast(jobs, etas, {
            costOf: jobEnergyCost,
            motivationOf: jobMotivation,
            energyAt,
            priorMotivationCost: motivationAlreadyCommitted(),
            motivationWarn: CONFIG.MOTIVATION_WARN,
        });
    }

    // ------------------------------------------------------------
    //  Alvás
    // ------------------------------------------------------------
    // A játék az alvást ugyanazon az úton indítja, mint a munkát:
    // TaskQueue.add(new TaskSleep(townId, room)) -- pontosan ezt teszi a hotel
    // ablak indítógombja is. Alvás alatt a játék megemeli az energyRegen-t
    // (mérve 0,03 -> 0,125 luxusapartmanban), tehát az energiaképlet ugyanaz.
    //
    // Fizetős szobát SOHA nem választunk magunktól: a saját városban a szobák
    // ingyenesek, máshol pénzbe kerülnek, és a felhasználó pénzét nem költjük el
    // kérdés nélkül.
    let hotelRooms = null;          // { townId, rooms, at }
    let sleepOffer = null;          // épp kint lévő kérdés
    let sleepDeclinedUntil = 0;

    function canSleep() {
        try {
            const t = window.Character && window.Character.homeTown;
            return !!(t && t.town_id > 0 && typeof window.TaskSleep === 'function');
        } catch(e) { return false; }
    }

    function isSleeping() {
        return gameReady() && window.TaskQueue.queue.some(t => t && t.type === 'sleep');
    }

    function fetchHotelRooms(townId, cb) {
        const cached = hotelRooms;
        if (cached && cached.townId === townId && Date.now() - cached.at < CONFIG.JOB_INFO_TTL) {
            cb(cached.rooms);
            return;
        }
        if (!window.Ajax || typeof Ajax.remoteCallMode !== 'function') { cb(null); return; }
        try {
            Ajax.remoteCallMode('building_hotel', 'get_data', { town_id: townId }, (data) => {
                if (!data || data.error || !data.rooms) { cb(null); return; }
                hotelRooms = { townId, rooms: data.rooms, at: Date.now() };
                cb(data.rooms);
            });
        } catch(e) { cb(null); }
    }

    // A legjobb INGYENES szoba: a szoba "energy" mezője az a szint, ameddig az
    // alvás feltölt (kamra 64 ... luxusapartman 100).
    function bestFreeRoom(rooms) {
        let best = null;
        for (const key in rooms) {
            const r = rooms[key];
            if (!r || !r.available || !r.free) continue;
            if (!best || (r.energy || 0) > (best.energy || 0)) best = { key, ...r };
        }
        return best;
    }

    // Ameddig az alvás feltölt: a szoba szintje, de legfeljebb a saját maximum.
    function sleepTargetEnergy(roomKey) {
        const max = (window.Character && window.Character.maxEnergy) || 100;
        const r = hotelRooms && hotelRooms.rooms && hotelRooms.rooms[roomKey];
        return r && typeof r.energy === 'number' ? Math.min(max, r.energy) : max;
    }

    // Csak becslés a kijelzéshez: az alvás alatti regenerációt előre nem tudjuk
    // (a szerver állítja be induláskor), ezért a mért értékkel számolunk. Az
    // alvás úgyis addig tart, amíg fel nem töltődik -- akkor megszakítjuk.
    function estimateSleepSeconds(roomKey) {
        const c = window.Character;
        if (!c || typeof c.energy !== 'number') return 3600;
        const max = c.maxEnergy || 100;
        const target = sleepTargetEnergy(roomKey);
        const perHour = max * CONFIG.SLEEP_REGEN_ESTIMATE;
        if (perHour <= 0 || c.energy >= target) return 60;
        return Math.ceil((target - c.energy) / perHour * 3600);
    }

    // Egy alvásbejegyzés a listába. A kézzel indított alvás a lista VÉGÉRE megy,
    // mint bármelyik munka; az energiahiány miatt felajánlott a lista ELEJÉRE,
    // mert épp az a dolga, hogy a soron következő munkát tegye indíthatóvá.
    function makeSleepEntry(townId, room, roomName, x, y) {
        return {
            id: generateId(), retries: 0, deferrals: 0, rejections: 0,
            taskType: 'sleep',
            townId, room,
            jobName: `Alvás – ${roomName || room}`,
            jobId: 0,
            x: x || 0, y: y || 0,
            duration: estimateSleepSeconds(room),
        };
    }

    // A hotel ablak indítógombja a HotelWindow.start-ot hívja (a játék kódjából
    // kiolvasva), ezért ezt az egy függvényt vesszük át -- ez nyelvfüggetlen és
    // pontosabb, mint a gomb DOM-ból való kitalálása. Így a kézzel indított alvás
    // ugyanúgy a saját sorunkba kerül, mint bármelyik munka, és nem előzi meg a
    // már várakozó munkákat.
    function patchHotelStart() {
        const hw = window.HotelWindow;
        if (!hw || hw.__lisaPatched || typeof hw.start !== 'function') return;
        const orig = hw.start;
        hw.start = function(room) {
            if (!room || !CONFIG.QUEUE_MANUAL_SLEEP) return orig.apply(this, arguments);
            try {
                const townId = hw.townid;
                const rooms = hotelRooms && hotelRooms.townId === townId ? hotelRooms.rooms : null;
                const info = rooms && rooms[room];
                const pos = (window.Character && Character.homeTown && Character.homeTown.town_id === townId)
                    ? Character.homeTown : currentPosition() || { x: 0, y: 0 };
                const entry = makeSleepEntry(townId, room, info && info.name, pos.x, pos.y);
                extraJobs.push(entry);
                saveExtraQueueToStorage();
                updateUI();
                updateUIStatus(`Alvás sorba állítva (${extraJobs.length} várakozik).`);
                ensureProcessing();

                // A szoba adatai kellenek a megszakításhoz is (meddig tölt fel),
                // nem csak a névhez. Ha még nincsenek meg, most kérjük le.
                if (!info) {
                    fetchHotelRooms(townId, (rooms) => {
                        const r = rooms && rooms[room];
                        if (!r) return;
                        entry.jobName = `Alvás – ${r.name || room}`;
                        entry.duration = estimateSleepSeconds(room);
                        saveExtraQueueToStorage();
                        updateUI();
                    });
                }
            } catch(e) {
                console.error('[Lisa] Az alvás sorba állítása nem sikerült, a játék indítja:', e);
                return orig.apply(this, arguments);
            }
        };
        hw.__lisaPatched = true;
        console.log('[Lisa] A hotel alvásgombja a saját sorba kerül.');
    }

    function insertSleepJob() {
        const town = window.Character.homeTown;
        fetchHotelRooms(town.town_id, (rooms) => {
            const room = rooms && bestFreeRoom(rooms);
            if (!room) {
                updateUIStatus('Nincs ingyenes szoba a hotelben – alvás nem lett beszúrva.');
                return;
            }
            extraJobs.unshift(makeSleepEntry(town.town_id, room.key, room.name, town.x, town.y));
            saveExtraQueueToStorage();
            updateUI();
            updateUIStatus(`Alvás beszúrva a sor elejére (${room.name || room.key}).`);
            ensureProcessing();
        });
    }

    // Az alvás automatikus, de csak KÉRDÉS után -- a felhasználó így dönt.
    // Ha nemet mond, egy ideig nem kérdezünk újra, hogy ne zaklassuk.
    function maybeOfferSleep(neededEnergy) {
        if (!CONFIG.AUTO_SLEEP || !canSleep()) return;
        if (sleepOffer || Date.now() < sleepDeclinedUntil) return;
        if (isSleeping()) return;
        if (extraJobs.some(j => j.taskType === 'sleep')) return;
        sleepOffer = { needed: neededEnergy };
        renderSleepOffer();
    }

    function dismissSleepOffer(declined) {
        sleepOffer = null;
        if (declined) sleepDeclinedUntil = Date.now() + CONFIG.SLEEP_DECLINE_MS;
        renderSleepOffer();
    }

    // Van-e egyáltalán miért felébredni?
    function hasWorkWaiting() {
        if (extraJobs.some(j => j.taskType !== 'sleep')) return true;
        return gameReady() && window.TaskQueue.queue.some(t => t && t.type !== 'sleep');
    }

    // Futó alvás megszakítása, ha az energia elérte, amit ez a szoba adhat.
    // A játék cancelje a sorpozíciót várja, és a válaszban visszaküldi a valódi
    // energiát (sleep.onCancel), tehát utána azonnal pontos az állapotunk.
    //
    // Csak akkor ébresztünk, ha VAN mit dolgozni: alvás közben a karaktert nem
    // lehet párbajra hívni, tehát munka híján az alvás a jobb állapot, még tele
    // energiával is. Enélkül a script minden alvást azonnal megszakítana.
    function cancelSleepIfFull() {
        if (!gameReady() || !isLeaderTab) return;
        if (!hasWorkWaiting()) return;
        const pos = window.TaskQueue.queue.findIndex(t => t && t.type === 'sleep');
        if (pos === -1) return;
        const task = window.TaskQueue.queue[pos];
        // Csak a MÁR FUTÓ alvást szakítjuk meg, a sorban állót nem.
        if (task.queuePos !== 0) return;
        const room = task.data && task.data.room;
        const target = sleepTargetEnergy(room);
        const c = window.Character;
        if (!c || typeof c.energy !== 'number' || c.energy < target) return;
        try {
            console.log(`[Lisa] Alvás megszakítva: energia ${c.energy}/${target} (${room || 'ismeretlen szoba'}).`);
            window.TaskQueue.cancel(task.queuePos);
            updateUIStatus(`Alvás vége – energia ${c.energy}, jöhet a következő munka.`);
        } catch(e) {
            console.warn('[Lisa] Az alvás megszakítása nem sikerült:', e);
        }
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
    // Egy előrejelzés-sor emberi olvasatú figyelmeztetése, vagy üres szöveg.
    function forecastWarning(f) {
        if (!f) return '';
        const out = [];
        if (f.lowMotivation) out.push(`motiváció ${f.motivation}%`);
        if (f.notEnoughEnergy) out.push(`kevés energia (${f.energyBefore} < ${f.cost})`);
        return out.join(', ');
    }

    function pendingIconUrl(job) {
        try {
            if (!gameReady()) return null;
            const probe = job.taskType === 'sleep'
                ? new window.TaskSleep(job.townId, job.room)
                : new window.TaskJob(job.jobId, job.x, job.y, job.duration);
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
            /* Figyelmeztetés a munka ikonján: kevés motiváció vagy kevés energia.
               A csempe pozicionálását a játék adja, ezért az ikonhoz kötjük. */
            #queuedTasks .lisa-pending { position: relative; }
            #queuedTasks .lisa-pending .lisa-pending-warn {
                position: absolute; left: 2px; top: 2px; z-index: 5;
                font: bold 13px 'Georgia',serif; color: #e8a33d;
                text-shadow: 0 0 3px #000, 0 1px 0 #000;
                pointer-events: none;
            }
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

    function buildPendingItem(job, eta, forecast) {
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

        // A figyelmeztetés a játék sorában is látszik, az ikonon -- itt nézi a
        // felhasználó a munkáit, nem a panelben.
        const warnText = forecastWarning(forecast);
        if (warnText) {
            const warn = document.createElement('div');
            warn.className = 'lisa-pending-warn';
            warn.textContent = '⚠';
            item.appendChild(warn);
            item.dataset.warn = warnText;
        }

        item.title = eta
            ? (travelSec > 0
                ? `${job.jobName} — út: ${formatDuration(travelSec)} + munka: ${formatDuration(job.duration)}, várható: ${formatEta(eta)}`
                : `${job.jobName} — munka: ${formatDuration(job.duration)}, várható: ${formatEta(eta)}`)
            : `${job.jobName} — ${formatDuration(job.duration)} (várakozik)`;
        if (warnText) item.title += `\n⚠ ${warnText}`;

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
        // A figyelmeztetés is a kulcs része: ha egy munka motivációja vagy
        // energiája átlépi a határt, a sorokat újra kell rajzolni.
        const etas = computeEtas(extraJobs);
        const forecast = forecastForExtraQueue(extraJobs, etas);
        const warnKey = forecast.slice(0, shown.length).map(f => (forecastWarning(f) ? '1' : '0')).join('');
        const key = `${extraJobs.length}|${shown.map(j => j.id).join(',')}|${warnKey}`;
        if (key === renderedPendingKey && host.querySelector('.lisa-pending-sep')) return;
        renderedPendingKey = key;

        clearPendingRows(host);

        const sep = document.createElement('div');
        sep.className = 'lisa-pending-sep';
        const warned = forecast.filter(f => forecastWarning(f)).length;
        sep.textContent = `Extra sor — ${extraJobs.length}${warned ? ` ⚠${warned}` : ''}`;
        if (warned) sep.title = `${warned} munkánál kevés lesz a motiváció vagy az energia`;
        host.appendChild(sep);

        shown.forEach((job, i) => host.appendChild(buildPendingItem(job, etas[i], forecast[i])));

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
    // FONTOS: a sorhossz növekedése még NEM bizonyíték. A TaskQueue.add szinkron
    // push-ol, a szerver viszont utólag elutasíthatja a munkát (szintkövetelmény,
    // energiahiány), és akkor a játék kiveszi őket a sorból. Ha ilyenkor nem
    // tennénk vissza őket, a munkák NÉMÁN elvesznének -- élesben pontosan ez
    // történt 8 munkával. Ezért megjegyezzük, mit adtunk át, és a válasz alapján
    // a visszautasítottakat visszatesszük a lista elejére.
    function startJobsViaGame(jobs) {
        if (!gameReady() || !jobs.length) return 0;
        const before = gameQueueLength();
        try {
            window.TaskQueue.add(jobs.map(j => j.taskType === 'sleep'
                ? new window.TaskSleep(j.townId, j.room)
                : new window.TaskJob(j.jobId, j.x, j.y, j.duration)));
        } catch(e) {
            console.error('[Lisa] TaskQueue.add hiba:', e);
            return 0;
        }
        const accepted = Math.max(0, gameQueueLength() - before);
        inFlightBatch = accepted > 0 ? { jobs: jobs.slice(0, accepted), at: Date.now() } : null;
        return accepted;
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

    // A szerver által visszautasított munkák visszakerülnek a lista ELEJÉRE, az
    // eredeti sorrendjükben -- a felhasználó sorrendje így sértetlen marad.
    // Nem dobjuk el őket néhány próbálkozás után: a leggyakoribb ok (nincs elég
    // energia) magától elmúlik, csak várni kell rá. Ezért lassan próbálkozunk
    // újra, a szerver üzenetét pedig kiírjuk, hogy látszódjon az OK.
    // Duplázódó várakozás. Az energiahiány a leggyakoribb ok, és az energia
    // óránként csak néhány pontot regenerálódik: fix 20 másodperces újrapróbálás
    // mellett a munka percek alatt elfogyasztaná a próbálkozásait, és feladnánk
    // egy olyan munkát, ami húsz perc múlva simán elindulna. Így a tíz
    // próbálkozás összesen több mint egy órát fog át.
    function rejectBackoffMs(rejections) {
        const n = Math.max(1, rejections || 1);
        return Math.min(CONFIG.REJECT_BACKOFF_MS * Math.pow(2, n - 1), CONFIG.REJECT_BACKOFF_MAX);
    }

    function requeueRejected(rejected) {
        if (!rejected.length) return;
        const keep = [], dropped = [];
        rejected.forEach(({ job, msg }) => {
            job.rejections = (job.rejections || 0) + 1;
            job.lastRejectMsg = msg;
            (job.rejections > CONFIG.MAX_REJECTIONS ? dropped : keep).push(job);
        });
        if (keep.length) extraJobs.unshift(...keep);
        dropped.forEach(job => console.error(
            `[Lisa] Munka feladva ${CONFIG.MAX_REJECTIONS} szerveroldali elutasítás után: ${job.jobName} – ${job.lastRejectMsg}`));

        saveExtraQueueToStorage();
        updateUI();

        const first = rejected[0];
        const reason = (first.msg || 'a szerver nem fogadta el').replace(/<[^>]*>/g, '').slice(0, 90);
        console.warn(`[Lisa] A szerver ${rejected.length} munkát utasított vissza: ${reason}`);

        if (!keep.length) {
            updateUIStatus(`${dropped.length} munka feladva – ${reason}`);
            return;
        }
        const waitMs = rejectBackoffMs(Math.max(...keep.map(j => j.rejections)));
        updateUIStatus(`${keep.length} munka visszakerült a sorba, újra ~${formatDuration(waitMs / 1000)} múlva – ${reason}`);
        if (!paused && isLeaderTab) scheduleNextJob(waitMs);
    }

    // A játék add-válasza. Csak akkor nyúlunk hozzá a listához, ha a kérés
    // munkái pontosan az általunk átadott köteg -- egy párhuzamos, felhasználói
    // indítás válasza nem szólhat bele.
    function handleAddResponse(responseText, reqBody) {
        const batch = inFlightBatch;
        inFlightBatch = null;
        if (!batch || Date.now() - batch.at > CONFIG.ADD_RESPONSE_TTL) return;
        if (!addResponseMatchesBatch(extractTasksFromBody(reqBody), batch.jobs)) return;

        let data = null;
        try { data = JSON.parse(responseText); } catch(e) { return; }
        const rejected = rejectedFromAddResponse(batch.jobs, data);
        if (!rejected.length) {
            batch.jobs.forEach(j => { j.rejections = 0; });
            return;
        }
        requeueRejected(rejected);
    }

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

                // Elsőként a saját kötegünk sorsa: a szerver utólag is
                // visszautasíthatja, amit a játék már betett a sorba.
                handleAddResponse(xhr.responseText, reqBody);

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

            // Alvás alatt nem töltjük a sort. A munka energiája a sorba
            // kerüléskor levonódik, tehát az alvás alatt beküldött munkák épp azt
            // az energiát ennék meg, amiért alszunk -- és az alvás sosem érné el
            // a célszintet, amire megszakítanánk.
            if (isSleeping() && extraJobs[0] && extraJobs[0].taskType !== 'sleep') {
                updateUIStatus(`Alvás folyamatban – ${extraJobs.length} munka várja az ébredést.`);
                scheduleNextJob(rand(CONFIG.FULL_QUEUE_POLL_MIN, CONFIG.FULL_QUEUE_POLL_MAX));
                return;
            }

            // Energiafedezet. A szerver úgyis visszautasítaná, csak épp azután,
            // hogy a játék már betette a sorba -- azt a kört itt megspóroljuk, és
            // pontosan addig várunk, amíg az energia tényleg összejön. A költséget
            // a szervertől tudjuk; ha még nem tudjuk, nem tippelünk, hanem küldünk.
            const head = extraJobs[0];
            const headCost = jobEnergyCost(head);
            if (headCost !== null && typeof Character.energy === 'number' && Character.energy < headCost) {
                const waitMs = msUntilEnergy(headCost);
                updateUIStatus(`${head.jobName}: ${headCost} energia kell, van ${Character.energy} – várakozás ~${formatDuration(waitMs / 1000)}`);
                maybeOfferSleep(headCost);
                scheduleNextJob(Math.min(Math.max(waitMs, CONFIG.MIN_SEND_GAP), CONFIG.MAX_WAIT_MS));
                return;
            }

            // FONTOS: csak megnézzük a sor elejét, nem vesszük le. A munkák
            // kizárólag akkor kerülnek ki a listából, ha a játék tényleg
            // elfogadta őket. Hibánál, elutasításnál, kivételnél sem tűnhet el
            // semmi -- ez szerkezetileg zárja ki a "munka eltűnt" hibaosztályt.
            // Az alvást MAGÁBAN küldjük: a mögötte lévő munkák energiája már a
            // sorba kerüléskor levonódna, pont az alvás alatt gyűjtött energiából.
            const batch = extraJobs[0].taskType === 'sleep'
                ? extraJobs.slice(0, 1)
                : extraJobs.slice(0, freeSlots());
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
            .filter(j => j && (j.taskType === 'sleep'
                ? (parseInt(j.townId, 10) > 0 && !!j.room)
                : (j.jobId !== undefined && j.jobId !== null && !isNaN(parseInt(j.jobId, 10)))))
            .map(j => {
                const base = {
                    id: j.id || generateId(),
                    retries: parseInt(j.retries, 10) || 0,
                    deferrals: parseInt(j.deferrals, 10) || 0,
                    rejections: parseInt(j.rejections, 10) || 0,
                    jobName: j.jobName || `Job #${j.jobId}`,
                    jobId: parseInt(j.jobId, 10) || 0,
                    x: parseInt(j.x, 10) || 0,
                    y: parseInt(j.y, 10) || 0,
                    duration: parseInt(j.duration, 10) || CONFIG.DEFAULT_DURATION,
                    taskType: j.taskType || 'job',
                };
                // Az alvásnak nincs munkaazonosítója; a város és a szoba írja le.
                if (base.taskType === 'sleep') {
                    base.townId = parseInt(j.townId, 10);
                    base.room = j.room;
                }
                return base;
            })
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
    //  13/b. ÉBRENTARTÁS (több órás sorokhoz)
    // ============================================================
    // Egy több órás sor csak akkor fut végig, ha a gép ÉS a fül is ébren marad.
    // Két külön akadály van, két külön megoldással:
    //
    //  - A képernyő elalvásával a gép is elalszik, és vele minden időzítő. Ezt a
    //    Screen Wake Lock tartja vissza. A böngésző csak LÁTHATÓ laptól fogadja
    //    el, és elrejtéskor magától elengedi -- ezért látszáskor újra kérjük.
    //  - A háttérben lévő fül időzítőit a Chrome percenkéntire ritkítja, hosszabb
    //    háttérlét után pedig be is fagyaszthatja a fület. A hangot lejátszó
    //    fület viszont nem: ezért szól egy hallhatatlanul halk hurok.
    //
    // Mindkettő csak akkor aktív, amikor tényleg van mit csinálni -- üres listánál
    // semmi nem tartja ébren a gépet, és a fülön sem jelenik meg a hangszóró ikon.
    // A script oldalán ennyi tehető; a gép alvását (caffeinate) és a Chrome
    // memóriakímélőjét a felhasználónak kell beállítania.
    let wakeLock = null;
    let keepAudio = null;
    let keepAwakeWanted = false;

    function requestWakeLock() {
        if (wakeLock || !keepAwakeWanted || !isVisible()) return;
        try {
            if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
            navigator.wakeLock.request('screen').then(lock => {
                if (!keepAwakeWanted) { try { lock.release(); } catch(e) {} return; }
                wakeLock = lock;
                lock.addEventListener('release', () => { wakeLock = null; });
            }).catch(() => { wakeLock = null; });   // rejtett fül, energiatakarékos mód
        } catch(e) { wakeLock = null; }
    }

    function releaseWakeLock() {
        try { if (wakeLock) wakeLock.release(); } catch(e) {}
        wakeLock = null;
    }

    // Hallhatatlanul halk, de nem NÉMA hurok: a teljesen néma hangot a böngésző
    // nem tekinti lejátszásnak, és a fül fagyasztás elleni védettsége is elmarad.
    function quietLoopUrl() {
        const rate = 8000, n = rate;             // 1 másodperc, 8 kHz, mono, 16 bit
        const buf = new ArrayBuffer(44 + n * 2);
        const view = new DataView(buf);
        const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
        str(0, 'RIFF');  view.setUint32(4, 36 + n * 2, true);  str(8, 'WAVE');
        str(12, 'fmt '); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        str(36, 'data'); view.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
        return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    }

    function startKeepAudio() {
        if (!keepAwakeWanted) return;
        if (!keepAudio) {
            keepAudio = new Audio(quietLoopUrl());
            keepAudio.loop = true;
            keepAudio.volume = 0.01;
        }
        if (keepAudio.paused) {
            // Kattintás előtt a böngésző letilthatja a lejátszást; a játékban
            // úgyis kattint a felhasználó, és akkor a következő kör elindítja.
            keepAudio.play().catch(() => {});
        }
    }

    function stopKeepAudio() {
        if (keepAudio && !keepAudio.paused) keepAudio.pause();
    }

    function updateKeepAwake() {
        const wanted = CONFIG.KEEP_AWAKE && !paused && extraJobs.length > 0;
        keepAwakeWanted = wanted;
        if (wanted) { requestWakeLock(); startKeepAudio(); }
        else { releaseWakeLock(); stopKeepAudio(); }
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
        patchHotelStart();      // a hotel ablak később is betöltődhet
        updateQueueBadge();
        updateExtraEtas(refreshForecast());
        updateEnergyForecastBar();
        updateKeepAwake();
        cancelSleepIfFull();
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
        // A képernyőzárolást a böngésző elrejtéskor elengedi, ezért látszáskor
        // újra kell kérni -- enélkül az első fülváltás után már nem védene.
        document.addEventListener('visibilitychange', () => {
            refreshLeadership();
            if (isVisible()) requestWakeLock();
        });
        // Bezáráskor elengedjük a vezetést: a bezárt fül eddig a TTL végéig fogta.
        window.addEventListener('pagehide', () => { releaseLeadership(); releaseWakeLock(); });
        // Az automatikus lejátszást a böngésző az első felhasználói mozdulatig
        // tilthatja; a játékban úgyis kattint a felhasználó.
        document.addEventListener('click', () => { if (keepAwakeWanted) startKeepAudio(); }, true);

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
            #lisa-extra-list li.lisa-row-warn { background: rgba(170,90,30,0.16); }
            .lisa-warn { flex: 0 0 auto; font-size: 11px; color: #a05a1e; margin-right: 3px; cursor: help; }
            .lisa-warn:empty { display: none; }
            .lisa-energy {
                flex: 0 0 auto; font-size: 10px; color: #4a6b42; margin-left: 6px;
                font-variant-numeric: tabular-nums; cursor: help;
            }
            .lisa-energy:empty { display: none; }
            .lisa-energy.lisa-energy-low { color: #a03020; font-weight: bold; }
            .lisa-eta { font-size: 10px; color: #6b5a42; white-space: nowrap; margin-left: 6px; font-variant-numeric: tabular-nums; }
            #lisa-extra-list .remove { color: #a03020; cursor: pointer; font-weight: bold; margin-left: 8px; font-size: 13px; line-height: 1; }
            #lisa-extra-list .remove:hover { color: #d04030; }
            #lisa-empty { padding: 8px 4px; font: italic 11px Georgia,serif; color: #6b5a42; text-align: center; }
            #lisa-sleep-offer {
                flex: 0 0 auto; display: flex; align-items: center; gap: 4px;
                margin: 0 20px 2px 2px; padding: 2px 4px;
                background: rgba(170,90,30,0.18); border: 1px solid #a05a1e; border-radius: 3px;
                font: 11px Georgia,serif; color: #3b2f1e;
            }
            #lisa-sleep-offer span { flex: 1 1 auto; }
            #lisa-sleep-offer button {
                flex: 0 0 auto; font: 10px Georgia,serif; color: #f0e4c6; cursor: pointer;
                background: linear-gradient(#6b5636,#4a3b28);
                border: 1px solid #2e2416; border-radius: 3px; padding: 1px 6px;
            }
            #lisa-sleep-offer button:hover { background: linear-gradient(#8a7048,#5c4a30); }
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
                <div id="lisa-sleep-offer" style="display:none"></div>
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

    // Az alvás felajánlása a panelben, nem felugró ablakban: a játék saját
    // dialógusai a sorra vonatkoznak, és egy odatévedt kattintás ott drága.
    function renderSleepOffer() {
        const box = document.getElementById('lisa-sleep-offer');
        if (!box) return;
        if (!sleepOffer) {
            box.style.display = 'none';
            box.textContent = '';
            return;
        }
        box.textContent = '';
        box.style.display = '';
        const text = document.createElement('span');
        text.textContent = `Kevés az energia (${sleepOffer.needed} kell). Alvás?`;
        const yes = document.createElement('button');
        yes.textContent = 'Igen';
        yes.title = 'Alvás beszúrása a sor elejére, a legjobb ingyenes szobába';
        yes.addEventListener('click', () => { dismissSleepOffer(false); insertSleepJob(); });
        const no = document.createElement('button');
        no.textContent = 'Nem';
        no.title = `Most nem – ${Math.round(CONFIG.SLEEP_DECLINE_MS / 60000)} percig nem kérdezünk újra`;
        no.addEventListener('click', () => dismissSleepOffer(true));
        box.appendChild(text);
        box.appendChild(yes);
        box.appendChild(no);
    }

    // Újranyitás után a státuszsor a helyőrzőt mutatná; írjuk ki a valós állapotot.
    function refreshIdleStatus() {
        updateUIStatus(
            paused ? 'Szüneteltetve'
            : !isLeaderTab ? 'Passzív fül – egy másik, látható fül dolgozza fel a sort.'
            : extraJobs.length ? `${extraJobs.length} munka várakozik.`
            : 'Kész.');
    }

    // A minimalizálás a wman-ben az ablak main div-jének ELREJTÉSE (fadeOut) plusz
    // egy bejegyzés a wman.minimizedIds-ben. Ilyenkor a bringToTop() önmagában
    // semmit nem csinál -- a panel "nem nyílik ki" a menügombra sem. A játék
    // erre a wman.reopen-t használja: az visszafadeolja és törli a minimalizált
    // állapotot is.
    function showLisaPanel() {
        const win = ensurePanel();
        if (!win) return;
        try {
            if (typeof wman.isMinimized === 'function' && wman.isMinimized(CONFIG.WINDOW_ID)
                && typeof wman.reopen === 'function') {
                wman.reopen(CONFIG.WINDOW_ID);
            } else {
                win.bringToTop();
            }
        } catch(e) {
            console.warn('[Lisa] A panel előhozása nem sikerült:', e);
        }

        // Végső háló: ha bármi mástól maradt rejtve vagy csúszott a képernyőn
        // kívülre (mentett megjelenés, átméretezett ablak), tegyük használhatóvá.
        const el = document.querySelector('.' + CONFIG.WINDOW_ID);
        if (!el) return;
        if (getComputedStyle(el).display === 'none') el.style.display = 'block';
        const r = el.getBoundingClientRect();
        const offScreen = r.right < 40 || r.bottom < 40
            || r.left > window.innerWidth - 40 || r.top > window.innerHeight - 40;
        // A felhasználó által odahúzott helyet tiszteletben tartjuk; csak akkor
        // rakjuk vissza, ha egyébként elérhetetlen lenne.
        if (offScreen) applyPanelGeometry(win);
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

            const warnEl = document.createElement('span');
            warnEl.className = 'lisa-warn';
            warnEl.textContent = '';

            const nameEl = document.createElement('span');
            nameEl.className = 'lisa-job-name';
            nameEl.textContent = job.jobName;
            nameEl.title = `${job.jobName} — ID:${job.jobId}, x:${job.x}, y:${job.y}, ${formatDuration(job.duration)}`;

            const energyEl = document.createElement('span');
            energyEl.className = 'lisa-energy';

            const etaEl = document.createElement('span');
            etaEl.className = 'lisa-eta';

            const removeEl = document.createElement('span');
            removeEl.className = 'remove';
            removeEl.textContent = '✕';
            removeEl.title = 'Eltávolítás';
            removeEl.addEventListener('click', () => removeExtraJobById(job.id));

            li.appendChild(warnEl);
            li.appendChild(nameEl);
            li.appendChild(energyEl);
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

    // Egy sor figyelmeztetései és energiaelőrejelzése. A motiváció a munka
    // BEFEJEZÉSEKOR csökken, ezért itt a munka INDULÁSÁRA jósolt érték látszik --
    // a kérdés úgy hangzik, hogy "mennyi motivációval fog nekiállni".
    function paintForecastRow(li, job, f) {
        if (!f) return;
        const warnEl = li.querySelector('.lisa-warn');
        const energyEl = li.querySelector('.lisa-energy');
        if (!warnEl || !energyEl) return;

        const reasons = [];
        if (f.lowMotivation) reasons.push(`motiváció ${f.motivation}% (≤ ${CONFIG.MOTIVATION_WARN}%)`);
        if (f.notEnoughEnergy) reasons.push(`nem lesz elég energia (${f.energyBefore} < ${f.cost})`);
        warnEl.textContent = reasons.length ? '⚠' : '';
        warnEl.title = reasons.length ? `${job.jobName} – ${reasons.join(', ')}` : '';
        li.classList.toggle('lisa-row-warn', reasons.length > 0);

        energyEl.textContent = f.energyAfter === null ? '' : `⚡${Math.max(0, f.energyAfter)}`;
        energyEl.title = f.energyAfter === null ? '' :
            `Induláskor ${f.energyBefore} energia, a munka ${f.cost}-t visz, marad ${f.energyAfter}`
            + (f.motivation === null ? '' : `\nMotiváció induláskor: ${f.motivation}%`);
        energyEl.classList.toggle('lisa-energy-low', !!f.notEnoughEnergy);
    }

    // Csak az időpont-szövegeket írja át, a sorokat nem építi újra: így percenként
    // sokszor frissülhet anélkül, hogy a listát folyamatosan újrarajzolnánk.
    // Az előrejelzés a paneltől FÜGGETLENÜL frissül: az energiasáv a karakter
    // dobozában akkor is látszik, ha a panel épp zárva vagy minimalizálva van.
    function refreshForecast() {
        refreshJobInfo(extraJobs);
        const etas = computeEtas(extraJobs);
        lastForecast = forecastForExtraQueue(extraJobs, etas);
        return etas;
    }

    function updateExtraEtas(precomputed) {
        const etas = precomputed || refreshForecast();
        if (!uiExtraList) return;
        const forecast = lastForecast;
        updateTotalEta(etas);
        etas.forEach((eta, i) => {
            const li = uiExtraList.children[i];
            if (!li || li.dataset.id !== eta.id) return;
            paintForecastRow(li, extraJobs[i], forecast[i]);
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

    console.log('[Lisa] Modular v12.4 betöltve.');
})();
