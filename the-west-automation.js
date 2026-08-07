// ==UserScript==
// @name         The-West Modular Job Queue (Lisa v12.14)
// @namespace   http://tampermonkey.net/
// @version     12.14
// @description A játék saját TaskQueue-ján keresztül indít munkát, a maradékot FIFO sorrendben sorba állítja, várható kezdés/befejezés kijelzéssel.
// @author      Lisa
// @include     https://*.the-west.hu/*
// @match       https://*.the-west.hu/*
// @grant       none
// @run-at      document-end
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    //  1. SETTINGS
    // ============================================================
    const CONFIG = {
        JOB_ADD_ENDPOINT: 'window=task&action=add',
        SAFETY_MARGIN_MS: 800,
        FULL_QUEUE_POLL_MIN: 15000,
        FULL_QUEUE_POLL_MAX: 25000,
        MAX_RETRIES: 5,              // after this many failures a job moves to the back
        MAX_DEFERRALS: 2,            // dropped after this many failed rounds
        MAX_REJECTIONS: 10,          // give up after this many SERVER-side rejections
        REJECT_BACKOFF_MS: 20000,    // how long we wait after the first rejection
        REJECT_BACKOFF_MAX: 600000,  // ...then doubled, up to this much
        ADD_RESPONSE_TTL: 20000,     // no response is paired with a batch older than this
        IDLE_RESCHEDULE: 5000,       // emergency brake: in case a branch forgets to arm a timer
        // Version-independent keys: the version lives in the content, not in the key,
        // otherwise every release would orphan the user's saved queue.
        STORAGE_EXTRA_QUEUE: 'lisa_extra_queue',
        STORAGE_HISTORY: 'lisa_history',
        STORAGE_LEADER: 'lisa_leader_tab',
        STORAGE_SLEEP_MODE: 'lisa_sleep_mode',
        STORAGE_VERSION: 2,
        LEGACY_EXTRA_QUEUE: 'lisa_extra_params_v1020',
        LEGACY_HISTORY: 'lisa_modular_history_v97',
        MIN_SEND_GAP: 2000,          // between two consecutive sends
        WATCH_INTERVAL: 1000,        // how often we look at the game's queue and the ETAs
        TICK_STALL_WARN: 5000,       // a tick gap larger than this gets logged
        LONG_GAP_MS: 30000,          // after a gap longer than this the game is behind too
        LONG_GAP_SETTLE_MS: 1500,    // ...so we give it this long before deciding anything
        AUDIO_STALL_MS: 4000,        // this long without a timeupdate and we call it stalled
        SLOT_FREED_DELAY: 400,       // delay before starting the next job once a slot frees
        NEW_WORK_DELAY: 500,         // how far forward new work pulls the next round
        MAX_WAIT_MS: 3600000,        // so a bogus date_done can never stall us forever
        TIMER_CHUNK: 60000,          // long waits are woken in chunks this size
        LEADER_HEARTBEAT: 5000,
        LEADER_TTL: 15000,           // after this long without a heartbeat, processing is takeable
        MAX_HISTORY: 60,
        BOOT_MAX_ATTEMPTS: 60,
        WINDOW_ID: 'lisaExtraQueue',
        PANEL_WIDTH: 320,
        PANEL_HEIGHT: 210,           // about 4-5 job rows visible, the rest by scrolling
        PANEL_TOP: 140,
        PANEL_RIGHT: 35,
        MAX_AMOUNT: 99,
        MIN_AMOUNT: 1,
        FALLBACK_QUEUE_LIMIT: 4,     // only if the game's TaskQueue is unreachable
        DEFAULT_DURATION: 900,       // only if neither the DOM nor the history reveals it
        MAX_EXTRA_QUEUE: 500,
        KEEP_AWAKE: true,            // guards against screen sleep and tab freezing
        MOTIVATION_WARN: 75,         // we warn at or below this motivation
        JOB_INFO_TTL: 300000,        // how long a motivation/energy-cost read stays valid
        AUTO_SLEEP: true,            // offer sleeping when energy runs short
        QUEUE_MANUAL_SLEEP: true,    // sleep started in the hotel also goes into our own queue
        SLEEP_DECLINE_MS: 1800000,   // after a "No" we don't ask again for this long
        SLEEP_REGEN_ESTIMATE: 0.125, // only for estimating the DISPLAYED sleep length (measured)
        JOBGROUP_MAX_DIST: 200,      // a job group farther than this isn't accepted as the location
        GAME_QUEUE_PREVIEW: 6,       // how many waiting jobs show in the game's queue widget
    };

    // ============================================================
    //  2. INTERNAL STATE
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
    let inFlightBatch = null;        // what we just handed to the game, until the response
    let lastForecast = [];           // per-job energy/motivation forecast
    let renderedPendingKey = '';
    let pendingObserver = null;
    let observedHost = null;

    let uiExtraList, uiStatus, uiExtraCount, uiEmpty, uiPauseBtn;
    let uiQueueStatus, uiTotalEta;

    const OriginalXHR = window.XMLHttpRequest;

    // ============================================================
    //  3. HELPERS
    // ============================================================
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const TAB_ID = generateId();

    // Anything over a minute is never shown in seconds: "~400 mp" is unreadable.
    // Minutes round UP, because while waiting "1 more min" beats "0 min".
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

    // tasks[N][jobId] & friends -> a normalized job object, or null.
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

    // EVERY job of one request, in order. The response's tasks[] array maps by
    // index onto the request's jobs, so pairing them needs the whole list.
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
                    jobId: isNaN(id) ? null : id,      // a sleep has no job id
                    x: parseInt(byIdx[i].x, 10) || 0,
                    y: parseInt(byIdx[i].y, 10) || 0,
                    duration: parseInt(byIdx[i].duration, 10) || CONFIG.DEFAULT_DURATION,
                    taskType: byIdx[i].taskType || 'job',
                };
            })
            .filter(t => t.jobId !== null || t.taskType !== 'job');
    }

    // The response's tasks[i] answers the i-th job of the request, and is either
    // {task:{...}} or {error:true,msg:"..."}. Returns the failed ones paired with
    // their job object. On a top-level error the WHOLE batch failed.
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

    // The response is about OUR batch only if the request's jobs are exactly ours,
    // in the same order. Without this, a concurrent start by the user would
    // modify our list too.
    function addResponseMatchesBatch(bodyTasks, batch) {
        return !!batch && bodyTasks.length === batch.length
            && bodyTasks.every((t, i) => {
                const mine = batch[i];
                // A sleep carries neither job id nor duration in the request,
                // so there the task type is the only handle.
                if ((mine.taskType || 'job') !== 'job') return t.taskType === mine.taskType;
                return t.jobId === mine.jobId && t.duration === mine.duration;
            });
    }

    function updateUIStatus(text) {
        if (!uiStatus) return;
        uiStatus.textContent = text;
        // Tick health shows up on hover: a background tab's slowdown would
        // otherwise be invisible, and that is exactly what we want to measure.
        uiStatus.title = tickHealthText();
    }

    // The header shows the live state of the game's queue. It used to hold the
    // session hash, which TaskQueue.add made unnecessary.
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
    //  4. THE GAME'S JOB QUEUE (LIVE, FROM THE GAME'S OWN STATE)
    // ============================================================
    // TaskQueue is the game's own, live job queue. We model nothing and store
    // nothing about it: it is the authoritative answer to every question. The
    // script used to guess the queue's state out of XHR responses, and every
    // drift came from that guesswork.
    function gameReady() {
        return typeof window.TaskQueue === 'object' && window.TaskQueue !== null
            && Array.isArray(window.TaskQueue.queue) && typeof window.TaskJob === 'function';
    }

    function gameQueueLength() {
        return gameReady() ? window.TaskQueue.queue.length : 0;
    }

    // The limit is 9 with premium and 4 without -- ask the game, never hardcode it.
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

    // A queue entry's date_done is in MILLISECONDS, not seconds, and the game
    // keeps it current -- no server/client clock sync needed.
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
    //  Predicted start / finish
    // ------------------------------------------------------------
    // Character.calcWayTo(x, y) gives the travel time in seconds from the CURRENT
    // position, but chaining needs the time between any two arbitrary points.
    // Verified by measurement: the time is exactly linear in euclidean distance
    // (the seconds-per-unit rate was identical in every direction and at every
    // distance), so we read the rate at runtime from a known offset. That way the
    // horse, the speed buffs and any future rebalancing apply by themselves, with
    // no hardcoded multiplier.
    function secondsPerDistanceUnit() {
        try {
            // The game's formula, read out of the bundle (GameMap.calcWayTime):
            //   time = euclidean distance * Game.travelSpeed * Character.speed
            // So the seconds-per-unit rate is available DIRECTLY, with no probe call --
            // and the horse and the speed buffs are already inside Character.speed.
            const g = window.Game, ch = window.Character;
            if (g && ch && typeof g.travelSpeed === 'number' && typeof ch.speed === 'number') {
                const rate = g.travelSpeed * ch.speed;
                if (isFinite(rate) && rate > 0) return rate;
            }
            // Fallback: if the game's internal fields are ever renamed, we measure.
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

    // The game's queue is sequential: extra jobs run after the one that finishes
    // LAST, not at the first free slot. The chain starts there, where that job
    // ends -- which is why its location matters too, for the travel time.
    function queueTailAnchor() {
        const now = Date.now();
        let tail = null;
        if (gameReady()) {
            for (const e of window.TaskQueue.queue) {
                let done = e && e.data && e.data.date_done;
                // A sleep always goes in as 8 hours, but we cancel it as soon as the
                // energy is full -- so we anchor the chain to the PREDICTED wake-up,
                // otherwise every job behind it would slip eight hours out.
                if (e && e.type === 'sleep' && typeof done === 'number') {
                    const wake = now + msUntilEnergyAtRate(sleepGoalForTask(e), sleepPerHour(e));
                    done = Math.min(done, wake);
                }
                if (typeof done === 'number' && done > 0 && (!tail || done > tail.at)) {
                    // For a sleep the coordinates live in data, not in post.
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

    // A sleep's length is not fixed: it follows how long we mean to sleep.
    // So we compute it live instead of using the stored duration -- that way the
    // estimate in the panel, in the game's queue and in the chain all move
    // together with the decision and with work added in the meantime.
    function jobDurationSeconds(job, index) {
        if (!job) return 0;
        if (job.taskType !== 'sleep') return job.duration || 0;
        return estimateSleepSeconds(job.room, job.sleepMode, (index || 0) + 1);
    }

    // [{ id, start, finish, travelMs }] in extraJobs order.
    function computeEtas(jobs) {
        const perUnit = secondsPerDistanceUnit();
        const anchor = queueTailAnchor();
        let at = anchor.at;
        let pos = anchor.pos;

        return jobs.map((job, idx) => {
            let travelMs = 0;
            if (perUnit !== null && pos && typeof job.x === 'number') {
                travelMs = Math.hypot(job.x - pos.x, job.y - pos.y) * perUnit * 1000;
            }
            const start = at + travelMs;
            const finish = start + jobDurationSeconds(job, idx) * 1000;
            at = finish;
            if (typeof job.x === 'number') pos = { x: job.x, y: job.y };
            return { id: job.id, start, finish, travelMs, estimated: perUnit !== null };
        });
    }

    // ------------------------------------------------------------
    //  Energy and motivation
    // ------------------------------------------------------------
    // We ask the game for both, we never model them:
    //  - the per-job energy cost and the motivation come from a single READ-ONLY
    //    call (Ajax.remoteCallMode "job"/"job"), which spends no energy;
    //  - future energy is computed with the game's own formula.
    // Nothing is hardcoded: the 3/hour regeneration, the 1/5/12 energy costs and
    // the motivation step all come from the server, so premium bonuses and future
    // rebalancing apply by themselves.
    const jobInfoCache = new Map();     // jobId -> { motivation, costs, at }
    const jobInfoPending = new Set();

    function serverNowSec() {
        try {
            if (window.Game && typeof Game.getServerTime === 'function') return Game.getServerTime();
        } catch(e) {}
        return Date.now() / 1000;
    }

    // The server/local clock offset is small (measured 1 s), but ours is in local
    // milliseconds while the energy anchor is in server seconds.
    function toServerSec(ms) {
        return ms / 1000 + (serverNowSec() - Date.now() / 1000);
    }

    // The game's own formula (Game.tick4Character), verbatim. The pair
    // (Character.energy, Character.energyDate) always belongs together: setEnergy
    // resets the date on every change. While asleep the game simply raises
    // energyRegen (measured 0.03 -> 0.125), so the same formula covers the
    // refill during sleep as well.
    function energyAt(ms) {
        const c = window.Character;
        if (!c || typeof c.energy !== 'number') return null;
        const max = c.maxEnergy || 100;
        const regen = typeof c.energyRegen === 'number' ? c.energyRegen : 0;
        const anchor = typeof c.energyDate === 'number' ? c.energyDate : serverNowSec();
        const secs = Math.max(0, toServerSec(ms) - anchor);
        return Math.min(max, Math.floor(c.energy + max * regen * secs / 3600));
    }

    // How long until energy reaches a level. This inverts the game's formula, so
    // it uses the same regen rate (including the raised one while asleep).
    function msUntilEnergyAtRate(target, perHour) {
        const c = window.Character;
        if (!c || typeof c.energy !== 'number') return CONFIG.MIN_SEND_GAP;
        const max = c.maxEnergy || 100;
        // We never get above the maximum: waiting for such a target would never end.
        target = Math.min(target, max);
        if (c.energy >= target) return 0;
        if (perHour <= 0) return CONFIG.MAX_WAIT_MS;      // no regeneration: don't spin
        return Math.ceil((target - c.energy) / perHour * 3600) * 1000;
    }

    function energyPerHour() {
        const c = window.Character;
        if (!c) return 0;
        return (c.maxEnergy || 100) * (typeof c.energyRegen === 'number' ? c.energyRegen : 0);
    }

    function msUntilEnergy(target) {
        return msUntilEnergyAtRate(target, energyPerHour());
    }

    // While asleep the game raises energyRegen, but ONLY once the sleep has
    // actually started (the character has arrived). So a not-yet-started sleep's
    // length must not be estimated with the awake rate -- that way an 8-hour
    // sleep "never ends", and every job behind it slips eight hours out. Until we
    // are really asleep we use the measured sleeping rate.
    function sleepingNow(task) {
        try {
            return !!task && task.queuePos === 0
                && typeof task.isArrived === 'function' && task.isArrived(serverNowSec());
        } catch(e) { return false; }
    }

    function sleepPerHour(task) {
        const c = window.Character;
        const max = (c && c.maxEnergy) || 100;
        return sleepingNow(task) ? energyPerHour() : max * CONFIG.SLEEP_REGEN_ESTIMATE;
    }

    function jobEnergyCost(job) {
        const info = jobInfoCache.get(job.jobId);
        const cost = info && info.costs ? info.costs[job.duration] : undefined;
        return typeof cost === 'number' ? cost : null;   // until we know it, we don't guess
    }

    function jobMotivation(jobId) {
        const info = jobInfoCache.get(jobId);
        return info && typeof info.motivation === 'number' ? info.motivation : null;
    }

    // One read-only query per job, with a TTL. It spends no energy and does not
    // touch the queue's state -- it exists purely for the display.
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

    // We query the VISIBLE jobs, not the whole list: even 99 identical jobs cost
    // a single request, because the cache is keyed by job id.
    function refreshJobInfo(jobs) {
        const seen = new Set();
        for (const job of jobs) {
            if (seen.has(job.jobId)) continue;
            seen.add(job.jobId);
            requestJobInfo(job);
        }
    }

    // Jobs already in the game's queue finish BEFORE ours, so the motivation they
    // consume already affects our very first job.
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

    // Per-job forecast. Motivation drops by the job's energy cost when the job
    // COMPLETES, whereas the energy is deducted the moment it enters the game's
    // queue -- so the two have to be tracked separately.
    function computeForecast(jobs, etas, opts) {
        const committed = Object.assign({}, opts.priorMotivationCost || {});
        let energyUsed = 0;
        // After a sleep we don't carry on from "energy regenerating from now on" but
        // from the level the sleep fills up to. Further regeneration is ignored here:
        // that makes the forecast pessimistic rather than untruthful.
        let carry = (typeof opts.initialCarry === 'number') ? opts.initialCarry : null;
        return jobs.map((job, i) => {
            const start = etas[i] ? etas[i].start : Date.now();
            const cost = opts.costOf(job);
            const base = opts.motivationOf(job.jobId);
            const motivation = (typeof base === 'number')
                ? Math.round(base * 100) - (committed[job.jobId] || 0)
                : null;
            const predicted = carry === null ? opts.energyAt(start) : carry;
            const energyBefore = predicted === null ? null : predicted - energyUsed;

            // A sleep does not consume energy, it refills it.
            if (job.taskType === 'sleep') {
                const target = opts.sleepTargetOf ? opts.sleepTargetOf(job, i) : null;
                carry = target;
                energyUsed = 0;
                return {
                    id: job.id, cost: null, motivation: null,
                    energyBefore, energyAfter: target,
                    lowMotivation: false, notEnoughEnergy: false, isSleep: true,
                };
            }

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

    // The FIRST job the forecast says there won't be energy for. This is where a
    // sleep belongs: up to here the list runs fine, from here it doesn't.
    function forecastShortageIndex(forecast) {
        return forecast.findIndex(f => f && f.notEnoughEnergy);
    }

    // ------------------------------------------------------------
    //  Forecast energy bar below the character's energy bar
    // ------------------------------------------------------------
    // The game's bar is a single div; the fill comes from the background sprite's
    // offset. The formula was read out of the game (WestUi.updateEnergy), so our
    // own bar looks pixel-identical -- only fainter, because it is a prediction.
    const ENERGY_BAR_WIDTH = 137;

    function energySpriteY() {
        try {
            return (window.Premium && Premium.hasBonus('regen')) ? -26 : -13;
        } catch(e) { return -13; }
    }

    // The game's calcWidth, verbatim.
    function energyBarFill(value, max, width) {
        return Math.min(width, Math.max(0, Math.ceil(width * (value / max * 100) / 100)));
    }

    // The game's energy bar. We explicitly EXCLUDE our own: the selector the game
    // updates through (#ui_character_container > .energy_bar) matches every child
    // carrying that class.
    function realEnergyBar() {
        return document.querySelector('#ui_character_container > .energy_bar:not(#lisa-energy-forecast)');
    }

    // Where our bar goes. Not a fixed 176 px: other scripts add bars to the
    // character box too (twdb adds the duel motivation, for one), and we would
    // overlap them. We align below the LOWEST bar in the box, excluding our own --
    // including it would make the bar walk further down every round.
    function forecastBarTop(real, bar, container) {
        const top = container.getBoundingClientRect().top;
        let bottom = real.getBoundingClientRect().bottom - top;
        container.querySelectorAll('.status_bar, .twdb_charcont_ext, [id*="duelmot"]').forEach(el => {
            if (el === bar || (bar && bar.contains(el))) return;
            const r = el.getBoundingClientRect();
            if (!r.height) return;                      // a hidden element doesn't count
            bottom = Math.max(bottom, r.bottom - top);
        });
        return Math.round(bottom) + 2;
    }

    function ensureEnergyForecastBar() {
        const real = realEnergyBar();
        if (!real) return null;
        const container = real.parentElement;
        let bar = document.getElementById('lisa-energy-forecast');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'lisa-energy-forecast';
            // DELIBERATELY no energy_bar class: with it, the game's own updateEnergy
            // would overwrite the forecast with the real energy on every energy
            // change. We copy the sprite off the real bar instead.
            bar.className = 'status_bar lisa-forecast-bar';
            container.appendChild(bar);
        }
        const cs = getComputedStyle(real);
        bar.style.position = 'absolute';
        bar.style.left = cs.left;
        bar.style.width = real.offsetWidth + 'px';
        bar.style.height = real.offsetHeight + 'px';
        bar.style.backgroundImage = cs.backgroundImage;      // the same bars.png
        bar.style.backgroundRepeat = 'no-repeat';
        bar.style.font = cs.font;
        bar.style.color = cs.color;
        bar.style.textAlign = cs.textAlign;
        bar.style.top = forecastBarTop(real, bar, container) + 'px';
        // The sprite's unfilled part is TRANSPARENT: with no backdrop the bar all but
        // vanished against the map at low energy. The game's bars sit inside the frame
        // so it never shows there -- ours hangs outside it, so it needs its own track.
        bar.style.backgroundColor = 'rgba(20,14,8,0.55)';
        bar.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,0.65)';
        bar.style.opacity = '0.85';
        bar.style.cursor = 'help';
        return bar;
    }

    // The energy predicted at the END of the list. Dynamic: the forecast includes
    // regeneration, so if energy recovers meanwhile the bar follows by itself.
    function updateEnergyForecastBar() {
        const bar = ensureEnergyForecastBar();
        if (!bar) return;
        const real = realEnergyBar();
        const width = (real && real.offsetWidth) || ENERGY_BAR_WIDTH;
        const c = window.Character;
        const max = (c && c.maxEnergy) || 100;
        const last = lastForecast.length ? lastForecast[lastForecast.length - 1] : null;
        const value = last && typeof last.energyAfter === 'number' ? last.energyAfter : null;

        // Nothing to predict with an empty list or an unknown cost.
        if (value === null || !extraJobs.length) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'block';
        const shown = Math.max(0, Math.min(max, value));
        bar.style.backgroundPosition =
            `${-width + energyBarFill(shown, max, width)}px ${energySpriteY()}px`;
        bar.textContent = `${shown} / ${max}`;
        bar.title = `Várható energia a lista végén (${extraJobs.length} munka után): ${value}`
            + (value < 0 ? `\nEnnyi energia nem lesz meg – ${-value} hiányzik.` : '');
        // If the list would eat all the energy, make that obvious.
        bar.style.boxShadow = value <= 0
            ? 'inset 0 0 0 1px #a03020'
            : 'inset 0 0 0 1px rgba(0,0,0,0.65)';
    }

    // If there is a sleep in the GAME's queue, our jobs start after it -- by then
    // energy has filled to the room's level, it does not creep up at the current
    // rate. Without this we used the "awake" rate across an 8-hour sleep: 8 energy
    // became 48 instead of 150, and the end-of-list forecast carried the same
    // error onwards. (A sleep in our own list already worked correctly.)
    function initialEnergyCarry() {
        if (!gameReady()) return null;
        let carry = null;
        for (const t of window.TaskQueue.queue) {
            if (t && t.type === 'sleep') {
                ensureSleepRoomData(t);
                carry = sleepGoalForTask(t);
            }
        }
        return carry;
    }

    // We need the hotel data for the running sleep: without it the goal guesses
    // the maximum, while a weaker room only fills up part of the way.
    function ensureSleepRoomData(task) {
        const townId = task && task.data && task.data.townId;
        if (!townId) return;
        if (hotelRooms && hotelRooms.townId === townId) return;
        fetchHotelRooms(townId, () => {});
    }

    function forecastForExtraQueue(jobs, etas) {
        return computeForecast(jobs, etas, {
            initialCarry: initialEnergyCarry(),
            costOf: jobEnergyCost,
            motivationOf: jobMotivation,
            energyAt,
            sleepTargetOf: (job, i) => sleepGoalForEntry(job, i),
            priorMotivationCost: motivationAlreadyCommitted(),
            motivationWarn: CONFIG.MOTIVATION_WARN,
        });
    }

    // ------------------------------------------------------------
    //  Sleeping
    // ------------------------------------------------------------
    // The game starts a sleep the same way as a job:
    // TaskQueue.add(new TaskSleep(townId, room)) -- exactly what the hotel
    // window's start button does. While asleep the game raises energyRegen
    // (measured 0.03 -> 0.125 in a luxurious apartment), so the formula holds.
    //
    // We NEVER pick a paid room by ourselves: rooms are free in the character's
    // own town and cost money elsewhere, and we don't spend the user's money
    // without asking.
    let hotelRooms = null;          // { townId, rooms, at }
    let sleepOffer = null;          // the question currently on screen
    let sleepDeclinedUntil = 0;
    // The decision about the RUNNING sleep, bound to the task's queue id. It is
    // persisted because a page reload must not ask the same question again.
    let runningSleepDecision = null;   // { queueId, mode }
    let pendingSleepMode = null;       // what we have just started from our list
    let sleepModeAsked = false;        // the running-sleep question is on screen

    function loadSleepDecision() {
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_SLEEP_MODE);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && parsed.queueId) runningSleepDecision = parsed;
        } catch(e) {}
    }

    function saveSleepDecision(queueId, mode) {
        runningSleepDecision = { queueId, mode };
        try {
            localStorage.setItem(CONFIG.STORAGE_SLEEP_MODE, JSON.stringify(runningSleepDecision));
        } catch(e) {}
    }

    // A running sleep's mode. With no decision on record the SAFE default is the
    // full sleep: a sleeping character cannot be challenged to a duel.
    function runningSleepMode(task) {
        if (!task) return 'full';
        if (runningSleepDecision && runningSleepDecision.queueId === task.queueId) {
            return runningSleepDecision.mode;
        }
        return 'full';
    }

    // Binds the CHOSEN mode of a sleep started from our own list to the task that
    // has just been created. This must not wait on the "is there work" condition:
    // if it did, an unbound mode would later stick to a COMPLETELY DIFFERENT
    // sleep -- which is exactly what happened live: after a manually started
    // sleep the script never asked how long to sleep and took it as full.
    function adoptPendingSleepMode() {
        if (!pendingSleepMode || !gameReady()) return;
        const task = window.TaskQueue.queue.find(t => t && t.type === 'sleep');
        if (task && task.queueId) {
            saveSleepDecision(task.queueId, pendingSleepMode);
            pendingSleepMode = null;
            return;
        }
        // No sleep in the game's queue nor in ours: the pending mode is orphaned.
        if (!extraJobs.some(j => j.taskType === 'sleep')) pendingSleepMode = null;
    }

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

    // The best FREE room: a room's "energy" field is the level sleeping there
    // fills up to (cubby 64 ... luxurious apartment 100).
    function bestFreeRoom(rooms) {
        let best = null;
        for (const key in rooms) {
            const r = rooms[key];
            if (!r || !r.available || !r.free) continue;
            if (!best || (r.energy || 0) > (best.energy || 0)) best = { key, ...r };
        }
        return best;
    }

    // What the sleep fills up to: the room's level, capped at our own maximum.
    function sleepTargetEnergy(roomKey) {
        const max = (window.Character && window.Character.maxEnergy) || 100;
        const r = hotelRooms && hotelRooms.rooms && hotelRooms.rooms[roomKey];
        return r && typeof r.energy === 'number' ? Math.min(max, r.energy) : max;
    }

    // How much energy the REMAINING jobs need, starting from the given index.
    // Energy regained meanwhile is deliberately left out: better to sleep a hair
    // longer than to run out just before a job.
    // We sum up to the next sleep -- beyond that there will be another refill.
    function energyNeededFrom(index) {
        let sum = 0;
        for (let i = Math.max(0, index); i < extraJobs.length; i++) {
            const job = extraJobs[i];
            if (job.taskType === 'sleep') break;
            const cost = jobEnergyCost(job);
            if (cost === null) return null;      // unknown cost: we don't guess
            sum += cost;
        }
        return sum;
    }

    // How long to sleep? Either until the room fills us up ('full'), or only
    // until the jobs behind it are covered ('enough'). The latter is always
    // computed LIVE, so if work is queued mid-sleep the goal rises by itself.
    function sleepGoalEnergy(mode, roomKey, fromIndex) {
        const roomTarget = sleepTargetEnergy(roomKey);
        if (mode !== 'enough') return roomTarget;
        const needed = energyNeededFrom(fromIndex);
        if (needed === null) return roomTarget;  // until we know, sleep the full length
        // With no work behind it there is no reason to wake early: a sleeping
        // character cannot be challenged to a duel, so a full sleep is better. This
        // also covers the case where the user has removed their jobs meanwhile --
        // then a previously chosen 'enough' falls back to full by itself.
        if (needed <= 0) return roomTarget;
        return Math.min(roomTarget, needed);     // the room's level is the ceiling
    }

    // Goal for a queued sleep entry: the rest of the list follows it.
    function sleepGoalForEntry(entry, index) {
        return sleepGoalEnergy(entry.sleepMode, entry.room, (index || 0) + 1);
    }

    // Goal for the sleep RUNNING in the game: our whole extra list follows it.
    function sleepGoalForTask(task) {
        const room = task && task.data && task.data.room;
        return sleepGoalEnergy(runningSleepMode(task), room, 0);
    }

    // Display estimate only: we can't know the regen rate during a sleep ahead of
    // time (the server sets it at start), so we use the measured value.
    function estimateSleepSeconds(roomKey, mode, fromIndex) {
        const c = window.Character;
        if (!c || typeof c.energy !== 'number') return 3600;
        const max = c.maxEnergy || 100;
        const target = sleepGoalEnergy(mode, roomKey, fromIndex);
        const perHour = max * CONFIG.SLEEP_REGEN_ESTIMATE;
        if (perHour <= 0 || c.energy >= target) return 60;
        return Math.ceil((target - c.energy) / perHour * 3600);
    }

    // A sleep entry for the list. A manually started sleep goes to the END of the
    // list like any job; one offered because of low energy goes to the FRONT,
    // because its whole job is to make the next job startable.
    function makeSleepEntry(townId, room, roomName, x, y, mode) {
        const sleepMode = mode === 'enough' ? 'enough' : 'full';
        // For a sleep started by hand in the hotel the user chose NO length --
        // 'full' is merely the default. We mark that separately, otherwise we
        // would take it for a decision and never ask.
        const modeChosen = mode === 'enough' || mode === 'full';
        return {
            id: generateId(), retries: 0, deferrals: 0, rejections: 0,
            taskType: 'sleep',
            townId, room, sleepMode, modeChosen,
            jobName: `Alvás – ${roomName || room}${sleepMode === 'enough' ? ' (amennyi kell)' : ''}`,
            jobId: 0,
            x: x || 0, y: y || 0,
            // Starting value only: the actual length is computed live.
            duration: estimateSleepSeconds(room, sleepMode, 0),
        };
    }

    // The hotel window's start button calls HotelWindow.start (read out of the
    // game's code), so we take over that one function -- locale-independent and
    // more accurate than guessing the button out of the DOM. This way a manually
    // started sleep goes into our own queue like any job, and does not jump ahead
    // of the jobs already waiting.
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
                ensureProcessing(CONFIG.NEW_WORK_DELAY);

                // The room data is needed for cancelling too (what level it fills to),
                // not just for the name. Fetch it now if we don't have it yet.
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
                console.error('[Lisa] Could not queue the sleep, letting the game start it:', e);
                return orig.apply(this, arguments);
            }
        };
        hw.__lisaPatched = true;
        console.log('[Lisa] The hotel start button now routes into our own queue.');
    }

    // The sleep goes exactly WHERE the energy runs out: up to there the list keeps
    // running, we don't needlessly stop jobs that are still affordable.
    function insertSleepJob(atIndex, mode) {
        const town = window.Character.homeTown;
        fetchHotelRooms(town.town_id, (rooms) => {
            const room = rooms && bestFreeRoom(rooms);
            if (!room) {
                updateUIStatus('Nincs ingyenes szoba a hotelben – alvás nem lett beszúrva.');
                return;
            }
            const pos = Math.max(0, Math.min(extraJobs.length, atIndex || 0));
            extraJobs.splice(pos, 0, makeSleepEntry(town.town_id, room.key, room.name, town.x, town.y, mode));
            saveExtraQueueToStorage();
            updateUI();
            updateUIStatus(pos === 0
                ? `Alvás beszúrva a sor elejére (${room.name || room.key}).`
                : `Alvás beszúrva a(z) ${pos + 1}. helyre (${room.name || room.key}).`);
            ensureProcessing(CONFIG.NEW_WORK_DELAY);
        });
    }

    // Sleeping is automatic, but only after ASKING -- the user decides.
    // On a "no" we stay quiet for a while so as not to nag: the game's dialog is
    // not raised again, but the offer stays in the panel in a collapsed form, so
    // the user can change their mind at any time without going to the hotel.
    function maybeOfferSleep(neededEnergy, atIndex) {
        if (!CONFIG.AUTO_SLEEP || !canSleep()) return;
        if (isSleeping() || extraJobs.some(j => j.taskType === 'sleep')) {
            // A sleep is already running or queued: there is nothing left to offer.
            clearDeclinedSleepOffer();
            return;
        }
        // The blocked job's OWN cost is misleadingly small ("1 needed") while a lot
        // of work still stands behind it. How long to sleep can only be decided from
        // the remaining list's total energy, so we store that too.
        const at = atIndex || 0;
        const total = energyNeededFrom(at);
        // An offer already on screen -- pending or declined -- is only kept up to
        // date: the list moves under it, and a stale "3 energy needed" is worse
        // than none. We never raise the dialog a second time for the same offer.
        if (sleepOffer) {
            sleepOffer.needed = neededEnergy;
            sleepOffer.at = at;
            sleepOffer.total = total;
            renderSleepOffer();
            return;
        }
        // Inside the decline window the offer is born collapsed: the row is there,
        // the dialog is not.
        const declined = Date.now() < sleepDeclinedUntil;
        sleepOffer = { needed: neededEnergy, at, total, declined };
        renderSleepOffer();
        if (!declined) showSleepDialog(sleepOffer);
    }

    // How much energy do the remaining jobs need? That number says how long it is
    // worth sleeping -- the blocked job's own cost (often 1) does not.
    // With one job left the two numbers are equal, so printing both is noise.
    function sleepOfferRestText(offer) {
        const total = offer && offer.total;
        if (typeof total !== 'number' || total <= 0) return '';
        return ` (a hátralévő munkákhoz ${total} energia kell)`;
    }

    // A question written into the panel is easy to miss, so we raise the game's
    // OWN dialog as well: it appears centred, in the game's own style.
    // The message is plain text -- Dialog escapes HTML, a <br /> would show up
    // literally (verified live).
    function showSleepDialog(offer) {
        if (!offer || offer.dialogShown) return false;
        try {
            if (!window.west || !west.gui || typeof west.gui.Dialog !== 'function') return false;
            const at = offer.at || 0;
            const rest = sleepOfferRestText(offer);
            const msg = at > 0
                ? `A(z) ${at + 1}. munkára elfogy az energia${rest}. `
                  + 'Beszúrjak elé egy alvást a legjobb ingyenes szobába?'
                : `Nincs elég energia a következő munkához${rest}. `
                  + 'Beszúrjak egy alvást a sor elejére?';

            let answered = false;
            // Three answers: sleep full, sleep only up to what the remaining jobs
            // need, or nothing. The decision applies to THIS one sleep only, and
            // travels onwards inside the entry.
            const dlg = new west.gui.Dialog('Alvás beszúrása?', msg, west.gui.Dialog.SYS_QUESTION)
                .addButton('Teljes alvás', () => {
                    answered = true;
                    const i = at;
                    dismissSleepOffer(false);
                    insertSleepJob(i, 'full');
                })
                .addButton('Csak amennyi kell', () => {
                    answered = true;
                    const i = at;
                    dismissSleepOffer(false);
                    insertSleepJob(i, 'enough');
                })
                .addButton('no', () => {
                    answered = true;
                    dismissSleepOffer(true);
                })
                .show();
            offer.dialogShown = true;

            // Closing with the ✕ must not go unanswered either: otherwise the offer
            // would stay "pending" forever and we would never ask again. We detect
            // the close from the element being detached.
            const main = typeof dlg.getMainDiv === 'function' ? dlg.getMainDiv() : null;
            const el = main && main.jquery ? main[0] : main;
            if (el) {
                const timer = setInterval(() => {
                    if (el.isConnected) return;
                    clearInterval(timer);
                    if (!answered) dismissSleepOffer(true);
                }, 1000);
            }
            return true;
        } catch(e) {
            console.warn('[Lisa] The sleep dialog did not come up, falling back to the panel question:', e);
            return false;
        }
    }

    // The FORECAST triggers the offer too, not just the next job being unstartable
    // right now: if energy would run out in the middle of the list, that is worth
    // solving already. Without this the panel only said "-2" and offered no
    // solution for it.
    function offerSleepIfForecastRunsOut() {
        const i = forecastShortageIndex(lastForecast);
        if (i === -1) {
            // The shortage is gone -- energy recovered, or the jobs were removed.
            // A collapsed offer has nothing left to offer, so it goes. A PENDING
            // one is left alone: its dialog is on screen, the user is answering it.
            clearDeclinedSleepOffer();
            return;
        }
        maybeOfferSleep(lastForecast[i].cost, i);
    }

    // A declined offer is not thrown away -- only the nagging stops. The row stays
    // in the panel, collapsed to a single button, so the user can come back to it
    // at any time; `sleepDeclinedUntil` keeps the game's dialog away meanwhile.
    function dismissSleepOffer(declined) {
        if (declined) sleepDeclinedUntil = Date.now() + CONFIG.SLEEP_DECLINE_MS;
        if (declined && sleepOffer) sleepOffer.declined = true;
        else sleepOffer = null;               // accepted, or nothing left to keep
        renderSleepOffer();
    }

    // Reopens a declined offer: the three choices come back, and since the user
    // asked for them, the decline window ends here too.
    function reopenSleepOffer() {
        if (!sleepOffer) return;
        sleepOffer.declined = false;
        sleepDeclinedUntil = 0;
        renderSleepOffer();
    }

    function clearDeclinedSleepOffer() {
        if (!sleepOffer || !sleepOffer.declined) return;
        sleepOffer = null;
        renderSleepOffer();
    }

    // If the character is ALREADY asleep (started by the user or by the script)
    // and work arrives in the list, we have to ask what to do with the sleep: let
    // it run out, or cut it short once enough energy has built up for the jobs.
    // We ask once per sleep, and the answer stays bound to the task's queue id.
    function askRunningSleepMode() {
        if (!CONFIG.AUTO_SLEEP) return;
        if (!gameReady() || !isLeaderTab) return;
        // Adopting the chosen mode must not depend on whether work is waiting.
        adoptPendingSleepMode();
        if (sleepModeAsked) return;
        const task = window.TaskQueue.queue.find(t => t && t.type === 'sleep');
        if (!task || !task.queueId) return;
        // Nothing to wake up for: only work coming AFTER this sleep counts.
        if (!hasWorkWaiting(task)) return;
        if (runningSleepDecision && runningSleepDecision.queueId === task.queueId) return;
        if (!window.west || !west.gui || typeof west.gui.Dialog !== 'function') {
            saveSleepDecision(task.queueId, 'full');         // we can't even ask
            return;
        }

        sleepModeAsked = true;
        // The waiting-job count includes the GAME's queue, the energy need does not:
        // a job already in the queue has had its energy deducted, so it needs no
        // more. That is why we omit a 0 rather than print it.
        const needed = energyNeededFrom(0);
        const count = countWorkWaiting(task);
        const roomTarget = sleepTargetEnergy(task.data && task.data.room);
        // The question can come up while the sleep is still only queued (with jobs
        // running ahead of it), so we don't claim the character is already asleep.
        const lead = task.queuePos === 0 ? 'Alszol, és' : 'Alvás van a sorban, és';
        const msg = `${lead} ${count} munka vár mögötte`
            + (needed ? ` (${needed} energia kell hozzájuk). ` : '. ')
            + `Menjen végig az alvás (${roomTarget} energiáig), vagy szakítsam meg, amint elég energia gyűlt?`;
        let answered = false;
        const finish = (mode) => {
            answered = true;
            sleepModeAsked = false;
            saveSleepDecision(task.queueId, mode);
            updateUI();
        };
        try {
            const dlg = new west.gui.Dialog('Mi legyen az alvással?', msg, west.gui.Dialog.SYS_QUESTION)
                .addButton('Végig alszom', () => finish('full'))
                .addButton('Amint elég', () => finish('enough'))
                .show();
            // The ✕ would close without an answer here too: the safe default is the
            // full sleep, because a sleeping character cannot be duelled.
            const main = typeof dlg.getMainDiv === 'function' ? dlg.getMainDiv() : null;
            const el = main && main.jquery ? main[0] : main;
            if (el) {
                const timer = setInterval(() => {
                    if (el.isConnected) return;
                    clearInterval(timer);
                    if (!answered) finish('full');
                }, 1000);
            }
        } catch(e) {
            sleepModeAsked = false;
            saveSleepDecision(task.queueId, 'full');
        }
    }

    // Is there anything at all to wake up for? Only REAL work counts: the non-sleep
    // entries of our own list, and the jobs standing in the game's queue.
    // In the game's queue "not a sleep" is not enough on its own: travel and other
    // housekeeping entries are that too, and waking up for those makes no sense.
    // What identifies a job is a jobId in its `post` (filled in by the Task base
    // class for every entry; a sleep's post is only {taskType:'sleep'}).
    function hasWorkWaiting(sleepTask) {
        return countWorkWaiting(sleepTask) > 0;
    }

    // The same, but as a count -- the dialog text prints this number.
    //
    // When `sleepTask` is given, ONLY work standing BEHIND that sleep counts. This
    // is not nitpicking: the sleep is sent alone, but jobs started earlier may
    // still be running ahead of it in the game's queue. Those finish BEFORE the
    // sleep, so waking early does nothing for them -- yet in v12.11 they raised
    // the "how long should I sleep?" question for a sleep that had no job after
    // it at all.
    function countWorkWaiting(sleepTask) {
        let n = extraJobs.filter(j => j && j.taskType !== 'sleep').length;
        if (gameReady()) {
            const q = window.TaskQueue.queue;
            const after = sleepTask ? q.indexOf(sleepTask) : -1;
            n += q.filter((t, i) =>
                t && t.type !== 'sleep' && t.post && typeof t.post.jobId === 'number'
                && (after < 0 || i > after)).length;
        }
        return n;
    }

    // Cancel a running sleep once energy has reached what this room can give.
    // The game's cancel expects the queue position and returns the real energy in
    // its response (sleep.onCancel), so our state is exact right afterwards.
    //
    // We only wake up if there IS work to do: a sleeping character cannot be
    // challenged to a duel, so with no work sleeping is the better state, even at
    // full energy. Without this the script would cancel every sleep immediately.
    function cancelSleepIfFull() {
        if (!gameReady() || !isLeaderTab) return;
        const pos = window.TaskQueue.queue.findIndex(t => t && t.type === 'sleep');
        if (pos === -1) return;
        const task = window.TaskQueue.queue[pos];
        // We only cancel a sleep that is ALREADY RUNNING, never a queued one.
        if (task.queuePos !== 0) return;
        // ...and only if there is work BEHIND it. Work ahead of it is no reason.
        if (!hasWorkWaiting(task)) return;
        const room = task.data && task.data.room;
        // The goal is either the room's level ('full'), or just what the waiting
        // jobs need ('enough') -- the latter is recomputed live, so work added
        // during the sleep pushes it up.
        const target = sleepGoalForTask(task);
        const c = window.Character;
        if (!c || typeof c.energy !== 'number' || c.energy < target) return;
        try {
            console.log(`[Lisa] Sleep cancelled: energy ${c.energy}/${target} (${room || 'unknown room'}).`);
            window.TaskQueue.cancel(task.queuePos);
            updateUIStatus(`Alvás vége – energia ${c.energy}, jöhet a következő munka.`);
        } catch(e) {
            console.warn('[Lisa] Could not cancel the sleep:', e);
        }
    }

    function clockHM(ms) {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    // For a queue spanning several days a bare hh:mm would be misleading.
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
    //  Waiting jobs in the game's queue widget (display only)
    // ------------------------------------------------------------
    // The contents of #queuedTasks belong to the game, we don't write there. Our
    // own elements go into a separate container directly below it, with the game's
    // class names -- identical appearance without modifying the game's DOM.
    //
    // The container's parent (.middle) has a DIRECT click handler in the game that
    // reacts to the taskAbort / taskHalveway / taskInstantFinish / centermap / icon
    // classes and parses the queueId out of the class name. Our rows have no real
    // task behind them, so we let no click travel upwards at all -- without that,
    // one click would cancel a real job.
    // A forecast row's human-readable warning, or an empty string.
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
            /* Warning on the job icon: low motivation or not enough energy.
               The game positions the tile, so we anchor this to the icon. */
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
            /* The "+N" is NOT on a row of its own but in the place of the last
               displayed job, at job-tile size -- so the queue widget stays one
               row shorter. The .task class brings the game's tile size; the
               min-width/height is only a safety net in case it doesn't. */
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

    // The game's .task/.icon rules are scoped to #queuedTasks: in a separate
    // container neither the size nor the icon applies. So we append our rows into
    // #queuedTasks itself, ALWAYS after the real elements. The game maps children
    // by index, so appending at the end leaves the real elements' mapping intact,
    // and the tick does not rebuild the list (verified by measurement).
    function pendingHost() {
        const q = document.getElementById('queuedTasks');
        return (q && q.isConnected) ? q : null;
    }

    function clearPendingRows(host) {
        host.querySelectorAll('.lisa-pending, .lisa-pending-sep, .lisa-pending-more')
            .forEach(el => el.remove());
    }

    // The game hides #queuedTasks when nothing but the RUNNING task is in the
    // queue -- and our waiting rows vanish with it. This used to be rare, but
    // since we stopped feeding the game's queue during a sleep it is the typical
    // state: one running sleep with our list behind it. If we have something to
    // show, we override it. When empty we hand control back to the game -- an
    // empty container with no children takes no space, so it isn't visible.
    function setPendingHostVisible(host, visible) {
        host.style.display = visible ? 'block' : '';
    }

    // The game rebuilds the contents of #queuedTasks on every queue change, and
    // drops our rows with it. Left to the two-second watcher this is a visible
    // flicker: the waiting rows disappear and come back. So we replace them
    // immediately, in the same round.
    //
    // It cannot loop forever: we only re-render when our separator is MISSING,
    // and after our own insertion it is there.
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
        item.className = 'task lisa-pending';   // 'task' brings the game's styling
        item.dataset.id = job.id;

        // For queued jobs the game does NOT show travel on a row of its own (that
        // exists only for the running task), it folds it into the time: a 15 s job
        // starting with 5 s of travel shows as 00:00:20. We do the same, so where
        // there is no change of location only the job time shows, by itself.
        const travelSec = eta ? Math.round(eta.travelMs / 1000) : 0;
        const time = document.createElement('div');
        time.className = 'taskTime';
        const p = document.createElement('p');
        p.textContent = formatClock(travelSec + jobDurationSeconds(job, extraJobs.indexOf(job)));
        time.appendChild(p);

        const btns = document.createElement('div');
        btns.className = 'taskBtns';
        // Halving the travel makes no sense for a job that hasn't started: we render
        // it for layout parity with the real elements, but in a disabled state.
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

        // The warning also shows in the game's queue, on the icon -- this is where
        // the user looks at their jobs, not in the panel.
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

    // How many job rows show and how many are left for the "+N" tile. If everything
    // fits there is no tile; if not, the tile takes the LAST slot(!) -- so one job
    // fewer is visible, and in exchange it needs no row of its own.
    function previewSplit(total, preview) {
        if (total <= preview) return { shown: total, hidden: 0 };
        return { shown: preview - 1, hidden: total - (preview - 1) };
    }

    function renderPendingInGameQueue() {
        injectPendingStyles();
        const host = pendingHost();
        if (!host) return;

        if (!extraJobs.length) {
            if (renderedPendingKey !== '') {
                clearPendingRows(host);
                setPendingHostVisible(host, false);
                renderedPendingKey = '';
            }
            return;
        }
        setPendingHostVisible(host, true);

        const split = previewSplit(extraJobs.length, CONFIG.GAME_QUEUE_PREVIEW);
        const shown = extraJobs.slice(0, split.shown);
        const hidden = split.hidden;
        // The watcher calls every 2 s. We only rebuild when the list changed, or when
        // our rows disappeared during the game's redraw (self-healing).
        // The warnings are part of the key too: if a job's motivation or energy
        // crosses the threshold, the rows have to be redrawn.
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
            // 'task' brings the game's tile size so the "+N" sits exactly on one job
            // slot. Clicking it raises our own panel -- the full list is there.
            more.className = 'task lisa-pending lisa-pending-more';
            more.textContent = `+${hidden}`;
            more.title = `${hidden} további munka a listában – kattints a teljes listáért`;
            // We shield this from .middle's direct click handler too (see above).
            more.addEventListener('click', (e) => {
                e.stopImmediatePropagation();
                e.preventDefault();
                showLisaPanel();
            }, true);
            host.appendChild(more);
        }
    }

    // We call the game's own add, never raw XHR. That leaves the hash, the slot
    // handling and the limit check to the game, keeps the bottom-right queue UI in
    // sync (with raw XHR the server knew about the job but the game client did
    // not), and when the queue is full the game doesn't even send the request. The
    // return value comes from whether the queue grew: TaskQueue pushes synchronously.
    // We hand the jobs over in one batch, the way the game does: one request for
    // several jobs, not N of them. The return value is the number of jobs actually
    // accepted -- the queue length grows synchronously, so it is measurable at once.
    // IMPORTANT: a growing queue length is NOT proof. TaskQueue.add pushes
    // synchronously, but the server can still reject a job afterwards (level
    // requirement, not enough energy), and then the game removes them from the
    // queue. If we didn't put them back, the jobs would be lost SILENTLY -- which
    // is exactly what happened live with 8 jobs. So we remember what we handed
    // over and, from the response, put the rejected ones back at the front.
    function startJobsViaGame(jobs) {
        if (!gameReady() || !jobs.length) return 0;
        const before = gameQueueLength();
        try {
            window.TaskQueue.add(jobs.map(j => j.taskType === 'sleep'
                ? new window.TaskSleep(j.townId, j.room)
                : new window.TaskJob(j.jobId, j.x, j.y, j.duration)));
        } catch(e) {
            console.error('[Lisa] TaskQueue.add failed:', e);
            return 0;
        }
        const accepted = Math.max(0, gameQueueLength() - before);
        inFlightBatch = accepted > 0 ? { jobs: jobs.slice(0, accepted), at: Date.now() } : null;
        return accepted;
    }

    // ============================================================
    //  5. UNLOCKING THE AMOUNT SELECTOR
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
        console.log('[Lisa] Amount selector unlocked.');
    }

    // ============================================================
    //  6. AUTO-CLOSING THE "MORE JOBS?" DIALOG
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
                        console.log('[Lisa] "More jobs?" dialog dismissed.');
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function scheduleDialogClose() {
        // Rapid consecutive clicks used to leave several watchers spinning at once.
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
    //  7. EXTRACTING JOB DATA (FOR THE FALLBACK)
    // ============================================================
    // "45 mp", "15 p", "1 ó", "1 ó 30 p" -> seconds. Handles compound forms and
    // hours too: without that every long job looked like 15 minutes.
    function parseDurationText(text) {
        if (!text) return null;
        const t = text.trim().toLowerCase();
        let total = 0, matched = false;

        const hours = t.match(/(\d+)\s*(?:óra|ó|h)/);
        if (hours) { total += parseInt(hours[1], 10) * 3600; matched = true; }

        const seconds = t.match(/(\d+)\s*(?:mp|sec|s)\b/);
        if (seconds) { total += parseInt(seconds[1], 10); matched = true; }

        // Look for minutes only after stripping "mp", since "mp" also ends in 'p'.
        const minutes = t.replace(/\d+\s*mp/g, '').match(/(\d+)\s*(?:perc|min|p|m)\b/);
        if (minutes) { total += parseInt(minutes[1], 10) * 60; matched = true; }

        return matched && total > 0 ? total : null;
    }

    // The job window has THREE duration bars (short/middle/long), and each holds
    // its OWN start button. At low level only the 15 s one is unlocked, so there
    // any reading gives the right answer -- but from levels 10 and 20 all three
    // are active, and "the first non-disabled bar" would always return the 15 s
    // one, whichever button was actually clicked.
    // So the duration comes from the bar that contains the CLICKED button.
    function durationFromBar(bar) {
        if (!bar) return null;
        // The data-base keys (short/middle/long) match JobList.getDurations()'s keys
        // exactly, so there is no text to interpret.
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
            // A value the server confirmed earlier is more reliable than a blind default.
            const known = jobHistory.find(j => j.jobId === jobId);
            duration = known ? known.duration : CONFIG.DEFAULT_DURATION;
            console.warn(`[Lisa] Could not read the duration (job #${jobId}), using: ${duration}s`);
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
            // We can't read the job's data: let the game keep the click, and work out
            // the remainder after the response, from the live queue length.
            console.warn('[Lisa] Could not read the job data -- letting the game handle the click.');
            scheduleDialogClose();
            pendingJobName = jobName;
            pendingJobAmount = amount;
            pendingQueueLengthBefore = gameQueueLength();
            return;
        }

        // We handle every click. The whole batch goes to the end of the list, and the
        // processor immediately starts as many as fit. That keeps the order FIFO --
        // new jobs can't jump into free slots ahead of waiting ones -- and since we
        // call the game's own TaskQueue.add, the bottom-right queue UI stays in sync
        // (with raw XHR the server knew about the job but the client did not).
        e.stopImmediatePropagation();
        e.preventDefault();

        const name = jobName || `Job #${jobData.jobId}`;
        const added = addExtraJobs(jobData, amount, name);
        addJobToHistory({ ...jobData, jobName: name });
        updateUI();
        updateUIStatus(`${added} munka sorba állítva (${extraJobs.length} várakozik).`);
        ensureProcessing(CONFIG.NEW_WORK_DELAY);
    }, true);

    // ------------------------------------------------------------
    //  Quick-start arrows on the map
    // ------------------------------------------------------------
    // Clicking a job group on the map fans the individual job icons out in a
    // circle (.job.job-{jobId}), and hovering one reveals the quick-start arrow
    // (.instantwork-short | -middle | -long). This bypasses the big job window, so
    // we have to intercept it too, otherwise a job started this way would jump
    // ahead of the ones already waiting.
    //
    // The .job element is a direct child of #map and carries no coordinates. The
    // group's icon, however, stays rendered under the fanned-out circle with its
    // posx-/posy- classes, exactly at the circle's centre: measured 0 px from it,
    // while the next group was 528 px away. So we resolve the location by nearest
    // group, with a safety distance limit.
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

        // If anything is missing we do NOT touch it: let the game take its own path.
        // Starting with wrong coordinates is worse than not catching the click.
        if (!spot || !duration) {
            console.warn('[Lisa] Quick start: no location or duration found, leaving it to the game.');
            return;
        }

        // #map's delegated handler watches the .job and .instantwork elements too, so
        // we have to stop it here, otherwise the game would start the job as well.
        e.stopImmediatePropagation();
        e.preventDefault();

        let name = `Job #${jobId}`;
        try { const j = JobList.getJobById(jobId); if (j && j.name) name = j.name; } catch(err) {}

        const jobData = { jobId, x: spot.x, y: spot.y, duration, taskType: 'job' };
        addExtraJobs(jobData, 1, name);
        addJobToHistory({ ...jobData, jobName: name });
        updateUI();
        updateUIStatus(`${name} sorba állítva (${extraJobs.length} várakozik).`);
        ensureProcessing(CONFIG.NEW_WORK_DELAY);
    }, true);

    // ------------------------------------------------------------
    //  "Cancel all jobs" -- clears the waiting list too
    // ------------------------------------------------------------
    // The button opens a confirm dialog ("Az összes munka törlése", Igen/Nem) and
    // only empties the queue on approval. At that point the intent is clear: stop
    // everything. If only the game's queue emptied, the script would refill the
    // slots a second and a half later -- undoing the cancel, and spending the
    // energy the cancel had just refunded all over again.
    //
    // We don't act on the button but on the CONFIRMATION: after any of the dialog's
    // buttons we watch briefly for the queue actually reaching zero. That way "Nem"
    // cancels nothing, and we don't depend on the dialog's wording either.
    function clearExtraAfterCancelAll() {
        if (!extraJobs.length) return;
        const count = extraJobs.length;
        extraJobs = [];
        saveExtraQueueToStorage();
        updateUI();
        updateUIStatus(`Minden munka törölve – ${count} várakozó is.`);
        console.log(`[Lisa] Cancel-all confirmed: ${count} waiting jobs discarded.`);
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
                        clearInterval(confirmed);   // "Nem" -- the queue survived
                    }
                }, 200);
            }, true);
        }, 200);
    }

    document.addEventListener('click', function(e) {
        // We only observe; the game's button keeps working as usual.
        if (e.target.closest('#cancelAllInQueue')) watchCancelAllConfirm();
    }, true);

    // Jobs rejected by the server go back to the FRONT of the list, in their
    // original order -- so the user's ordering stays intact.
    // We don't drop them after a couple of tries: the most common cause (not
    // enough energy) passes by itself, it only has to be waited out. So we retry
    // slowly, and print the server's own message so the REASON is visible.
    // Doubling backoff. Low energy is the most common cause, and energy only
    // regenerates a few points per hour: with a fixed 20-second retry the job
    // would burn through its attempts in minutes, and we would give up on a job
    // that would start happily twenty minutes later. This way the ten attempts
    // span more than an hour in total.
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
            `[Lisa] Job given up after ${CONFIG.MAX_REJECTIONS} server-side rejections: ${job.jobName} -- ${job.lastRejectMsg}`));

        saveExtraQueueToStorage();
        updateUI();

        const first = rejected[0];
        const reason = (first.msg || 'a szerver nem fogadta el').replace(/<[^>]*>/g, '').slice(0, 90);
        console.warn(`[Lisa] The server rejected ${rejected.length} job(s): ${reason}`);

        if (!keep.length) {
            updateUIStatus(`${dropped.length} munka feladva – ${reason}`);
            return;
        }
        const waitMs = rejectBackoffMs(Math.max(...keep.map(j => j.rejections)));
        updateUIStatus(`${keep.length} munka visszakerült a sorba, újra ~${formatDuration(waitMs / 1000)} múlva – ${reason}`);
        if (!paused && isLeaderTab) scheduleNextJob(waitMs);
    }

    // The game's add response. We only touch the list if the request's jobs are
    // exactly the batch we handed over -- the response to a concurrent,
    // user-initiated start must not interfere.
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
            if (loadBound) return origSend.apply(this, arguments); // reused xhr: don't bind twice
            loadBound = true;
            xhr.addEventListener('load', function() {
                if (reqMethod !== 'POST') return;
                if (!reqUrl.includes(CONFIG.JOB_ADD_ENDPOINT)) return;

                // First, our own batch's fate: the server can still reject afterwards
                // what the game has already put into the queue.
                handleAddResponse(xhr.responseText, reqBody);

                // Only starts that did not come from our own processor get this far
                // (there pendingJobAmount is 0, since there was no intercepted click).
                const task = extractTaskFromBody(reqBody);
                if (!task) return;
                const jobName = pendingJobName || `Job #${task.jobId}`;
                addJobToHistory({ ...task, jobName });

                if (pendingJobAmount > 0) {
                    // The game updates TaskQueue BEFORE sending the request, so by the
                    // time the response arrives the live queue length is the real state.
                    const added = Math.max(0, gameQueueLength() - pendingQueueLengthBefore);
                    const remaining = Math.max(0, pendingJobAmount - added);
                    console.log(`[Lisa] Game-initiated start: asked ${pendingJobAmount}, accepted ${added}, left over ${remaining}`);
                    if (remaining > 0) {
                        const queued = addExtraJobs(task, remaining, jobName);
                        updateUI();
                        updateUIStatus(`${queued} maradék munka az extra sorba helyezve.`);
                        ensureProcessing(CONFIG.NEW_WORK_DELAY);
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

    // Carry over the prototype and the static constants: without them
    // XMLHttpRequest.DONE became undefined, and `x instanceof XMLHttpRequest`
    // was false for every instance in the eyes of the game and other userscripts.
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
    //  10. MANAGING THE EXTRA QUEUE
    // ============================================================
    // Batched add: a single localStorage write instead of N. Adding 99 jobs used
    // to mean 99 synchronous stringify+write cycles.
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
            console.warn(`[Lisa] Extra queue is full (${CONFIG.MAX_EXTRA_QUEUE}), ${wanted - n} job(s) did not fit.`);
        }
        if (n > 0) console.log(`[Lisa] Queued: ${n}x ${name} (ID:${params.jobId}) (${extraJobs.length} in total)`);
        return n;
    }

    // ============================================================
    //  12. PROCESSING
    // ============================================================
    // By default it only schedules when there is no timer at all -- that way the
    // per-second heartbeat doesn't trample the deliberate waits (full queue,
    // backoff after a rejection).
    //
    // When NEW work arrives, though, `pullInMs` can pull the deadline in:
    // without it, a job added during an in-flight backoff -- up to ten minutes
    // long -- would only start when that backoff expired. Live this looked like
    // a sleep queued by hand "doing nothing", and only a page reload brought
    // it to life.
    function ensureProcessing(pullInMs) {
        if (processing || paused || extraJobs.length === 0) return;
        if (!nextJobTimer) {
            scheduleNextJob(pullInMs || 500);
            return;
        }
        if (typeof pullInMs === 'number' && nextJobDeadline > Date.now() + pullInMs) {
            scheduleNextJob(pullInMs);
        }
    }

    function scheduleNextJob(delayMs) {
        if (nextJobTimer) clearTimeout(nextJobTimer);
        nextJobDeadline = Date.now() + Math.max(0, delayMs);
        armNextJobTimer();
    }

    // A one-hour setTimeout is unreliable in a background tab or on a sleeping
    // machine. We keep an absolute deadline and wake at most every TIMER_CHUNK.
    function armNextJobTimer() {
        const remaining = nextJobDeadline - Date.now();
        if (remaining <= 0) {
            nextJobTimer = null;
            processQueue();
            return;
        }
        nextJobTimer = setTimeout(armNextJobTimer, Math.min(remaining, CONFIG.TIMER_CHUNK));
    }

    // The chunked timer is still the tab's own timer, so it can be throttled in
    // the background. When the ticker (the worker) sees the deadline has already
    // passed, we fire it here at once instead of waiting for the next -- possibly
    // a minute later -- chunk. The same absolute deadline decides: nothing starts early.
    function pumpNextJobTimer() {
        if (!nextJobTimer || processing || paused) return;
        if (nextJobDeadline > Date.now()) return;
        clearTimeout(nextJobTimer);
        nextJobTimer = null;
        processQueue();
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
            // Only one tab may process the queue, otherwise two instances would
            // send from the same list in parallel.
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

            // We don't feed the queue during a sleep. A job's energy is deducted
            // when it enters the queue, so jobs sent while asleep would eat exactly
            // the energy we are sleeping for -- and the sleep would never reach the
            // goal we would cancel it at.
            if (isSleeping() && extraJobs[0] && extraJobs[0].taskType !== 'sleep') {
                updateUIStatus(`Alvás folyamatban – ${extraJobs.length} munka várja az ébredést.`);
                scheduleNextJob(rand(CONFIG.FULL_QUEUE_POLL_MIN, CONFIG.FULL_QUEUE_POLL_MAX));
                return;
            }

            // Energy cover. The server would reject it anyway, only after the game
            // has already put it into the queue -- we save that round trip here and
            // wait exactly as long as the regen needs. The cost comes from the
            // server; while we don't know it we don't guess, we send.
            const head = extraJobs[0];
            const headCost = jobEnergyCost(head);
            if (headCost !== null && typeof Character.energy === 'number' && Character.energy < headCost) {
                const waitMs = msUntilEnergy(headCost);
                updateUIStatus(`${head.jobName}: ${headCost} energia kell, van ${Character.energy} – várakozás ~${formatDuration(waitMs / 1000)}`);
                maybeOfferSleep(headCost);
                scheduleNextJob(Math.min(Math.max(waitMs, CONFIG.MIN_SEND_GAP), CONFIG.MAX_WAIT_MS));
                return;
            }

            // IMPORTANT: we only peek at the head of the list, we don't take it off.
            // Jobs leave the list only once the game has actually accepted them.
            // Nothing can vanish on an error, a rejection or an exception -- this is
            // what structurally rules out the "jobs vanished" class of bug.
            // A sleep is sent ALONE: the energy of jobs behind it would be deducted
            // on entering the queue, out of the very energy the sleep collects.
            const batch = extraJobs[0].taskType === 'sleep'
                ? extraJobs.slice(0, 1)
                : extraJobs.slice(0, freeSlots());
            console.log(`[Lisa] Starting ${batch.length} job(s) (${batch[0].jobName}...), free slots: ${freeSlots()}`);

            const accepted = startJobsViaGame(batch);

            if (accepted > 0) {
                const started = extraJobs.splice(0, accepted);
                started.forEach(j => { j.retries = 0; });
                // Carry the sleep's mode over to the task just started, so we don't
                // ask again about something the user has only just decided.
                // ONLY an explicitly chosen mode carries over. A sleep started by
                // hand has no decision behind it; we'll ask about that one later.
                const startedSleep = started.find(j => j.taskType === 'sleep' && j.modeChosen);
                if (startedSleep) pendingSleepMode = startedSleep.sleepMode || 'full';
                saveExtraQueueToStorage();
                updateUI();
                console.log(`[Lisa] Accepted ${accepted} job(s) (queue: ${gameQueueLength()}/${gameQueueLimit()})`);

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

            // The game accepted none of them. The list is untouched, we just wait.
            const job = extraJobs[0];
            job.retries = (job.retries || 0) + 1;
            const waitMs = waitUntilFreeSlotMs();
            console.warn(`[Lisa] The game refused it: ${job.jobName} (attempt ${job.retries})`);
            updateUIStatus(`${job.jobName} nem indult el – újra ~${formatDuration(waitMs / 1000)} múlva (${job.retries})`);

            // If it still won't go after many tries and there is other work, give it a chance.
            if (job.retries > CONFIG.MAX_RETRIES && extraJobs.length > 1) {
                extraJobs.shift();
                job.retries = 0;
                job.deferrals = (job.deferrals || 0) + 1;
                if (job.deferrals <= CONFIG.MAX_DEFERRALS) {
                    extraJobs.push(job);
                    updateUIStatus(`${job.jobName} a sor végére került (nem indult el).`);
                } else {
                    console.error(`[Lisa] Job dropped after ${job.deferrals} failed rounds: ${job.jobName}`);
                    updateUIStatus(`Feladva: ${job.jobName} (nem indult el)`);
                }
                updateUI();
            }
            saveExtraQueueToStorage();
            scheduleNextJob(waitMs);
        } finally {
            processing = false;
            // Emergency brake: in normal operation applyVerdict has already scheduled.
            // If it somehow hasn't, we restart slowly here – not with a 500 ms spin.
            if (!paused && extraJobs.length > 0 && !nextJobTimer) scheduleNextJob(CONFIG.IDLE_RESCHEDULE);
        }
    }

    // ============================================================
    //  13. UI AND STORAGE
    // ============================================================
    // The version goes into the content, not into the key, and we migrate once
    // from the old keys – so an update never strands the user's queue.
    function saveStore(key, list) {
        try {
            localStorage.setItem(key, JSON.stringify({ v: CONFIG.STORAGE_VERSION, data: list }));
        } catch(e) {
            console.warn(`[Lisa] Could not save (${key}):`, e && e.name);
        }
    }

    function loadStore(key, legacyKey) {
        try {
            const raw = localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.data)) return parsed.data;
                if (Array.isArray(parsed)) return parsed; // pre-versioning format
            }
            if (legacyKey) {
                const legacy = localStorage.getItem(legacyKey);
                if (legacy) {
                    const parsed = JSON.parse(legacy);
                    if (Array.isArray(parsed)) {
                        console.log(`[Lisa] Migrated from the old key: ${legacyKey}`);
                        return parsed;
                    }
                }
            }
        } catch(e) {
            console.warn(`[Lisa] Could not read (${key}):`, e && e.name);
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
                // A sleep has no job id; the town and the room describe it.
                if (base.taskType === 'sleep') {
                    base.townId = parseInt(j.townId, 10);
                    base.room = j.room;
                    base.sleepMode = j.sleepMode === 'enough' ? 'enough' : 'full';
                    base.modeChosen = !!j.modeChosen;
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
        // This used to be a removeItem, so an immediate reload lost the queue. Now we
        // write it back, so the stored state is always valid.
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
    //  13/b. KEEP-AWAKE (for multi-hour queues)
    // ============================================================
    // A multi-hour queue only runs to the end if the MACHINE and the TAB both stay
    // awake. There are two separate obstacles with two separate answers:
    //
    //  - When the screen sleeps the machine sleeps with it, and every timer with
    //    it. The Screen Wake Lock holds that off. The browser only grants it to a
    //    VISIBLE page and releases it on hide -- so we re-request it on show.
    //  - Chrome throttles a background tab's timers to once a minute, and after a
    //    longer spell in the background it may freeze the tab outright. Not a tab
    //    that is playing audio, though: hence an inaudibly quiet loop.
    //
    // Both are active only when there is genuinely something to do -- with an empty
    // list nothing keeps the machine awake, and no speaker icon appears on the tab.
    // This is as far as the script can go; machine sleep (caffeinate) and Chrome's
    // Memory Saver are for the user to configure.
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
            }).catch(() => { wakeLock = null; });   // hidden tab, power-saving mode
        } catch(e) { wakeLock = null; }
    }

    function releaseWakeLock() {
        try { if (wakeLock) wakeLock.release(); } catch(e) {}
        wakeLock = null;
    }

    // An inaudibly quiet but not SILENT loop: a fully silent track doesn't count
    // as playing for the browser, and the tab loses its protection from freezing.
    function quietLoopUrl() {
        const rate = 8000, n = rate;             // 1 second, 8 kHz, mono, 16 bit
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

    // CREATING the loop element is a separate step, and deliberately happens early.
    //
    // MEASURED (Chrome): a media element created in a HIDDEN tab is never even
    // loaded -- readyState stays 0, networkState stays LOADING, and the play()
    // promise never settles. Neither a blob: nor a data: URI gets it going.
    // The same element, created while the tab was VISIBLE, keeps playing happily
    // after the tab is hidden (measured: 7 minutes, 4 timeupdate/s).
    //
    // So we create the element at boot, when the tab is typically visible, and if
    // it was born hidden anyway (the game opened in a background tab) we try again
    // when the tab becomes visible. Without that, the "queue a long list, then put
    // the browser away" case -- the typical one -- is the one left unprotected.
    function ensureKeepAudioElement() {
        if (keepAudio && keepAudio.readyState > 0) return;   // already loaded, done
        if (keepAudio && !isVisible()) return;               // hidden: it wouldn't load
        if (!keepAudio) {
            keepAudio = new Audio(quietLoopUrl());
            keepAudio.loop = true;
            keepAudio.volume = 0.01;
            keepAudio.preload = 'auto';
            keepAudio.setAttribute('playsinline', '');
            keepAudio.addEventListener('timeupdate', () => { noteAudioProgress(); tick('audio'); });
        }
        try { keepAudio.load(); } catch(e) {}
    }

    function startKeepAudio() {
        if (!keepAwakeWanted) return;
        ensureKeepAudioElement();
        if (!keepAudio) return;
        if (keepAudio.paused) {
            // Before a user gesture the browser may block playback (Safari is
            // stricter about this). A gesture happens in the game anyway, and the
            // retry bound to it is what starts playback.
            // Stall detection counts from a successful start: without that we would
            // see a track that never started as "fine".
            keepAudio.play().then(noteAudioProgress).catch(() => {});
        }
    }

    function stopKeepAudio() {
        if (keepAudio && !keepAudio.paused) keepAudio.pause();
    }

    // Is it really PLAYING? `paused === false` is not enough: an element that
    // never started can be "not paused" too.
    //
    // IMPORTANT: do NOT compare currentTime between two ticks. The loop is exactly
    // 1 second and the tick is roughly that too, so the two frequencies alias and
    // the sampling keeps landing on the same phase over and over.
    // This is exactly what made v12.12 falsely report a "stalled" track -- in both
    // Chrome and Safari -- while playback was fine throughout (measured: timeupdate
    // arrived 4/s while the display claimed a stall).
    // So the TIME SINCE the last timeupdate decides: that is phase-independent.
    let lastAudioEventAt = 0;
    let audioStalled = false;

    function noteAudioProgress() {
        lastAudioEventAt = Date.now();
        audioStalled = false;
    }

    function checkKeepAudio() {
        if (!keepAwakeWanted || !keepAudio || keepAudio.paused) {
            audioStalled = false;
            return;
        }
        // readyState 0 is that "born in a hidden tab, never loaded" case: paused is
        // false there too, so this needs its own check.
        const neverLoaded = keepAudio.readyState === 0;
        audioStalled = neverLoaded
            || (lastAudioEventAt > 0 && (Date.now() - lastAudioEventAt) > CONFIG.AUDIO_STALL_MS);
        if (audioStalled) startKeepAudio();
    }

    function keepAwakeStatus() {
        if (!keepAwakeWanted) return 'kikapcsolva (nincs várakozó munka)';
        const parts = [];
        parts.push(wakeLock ? 'képernyőzár: aktív' : 'képernyőzár: nincs');
        if (!keepAudio) parts.push('hang: nincs');
        else if (keepAudio.readyState === 0)
            parts.push('hang: nem töltődött be (rejtett fülön indult; hozd előtérbe egyszer)');
        else if (keepAudio.paused) parts.push('hang: szünetel (kattints a játékba)');
        else if (audioStalled) parts.push('hang: elakadt');
        else parts.push('hang: szól');
        return parts.join(', ');
    }

    function updateKeepAwake() {
        const wanted = CONFIG.KEEP_AWAKE && !paused && extraJobs.length > 0;
        keepAwakeWanted = wanted;
        if (wanted) { requestWakeLock(); startKeepAudio(); checkKeepAudio(); }
        else { releaseWakeLock(); stopKeepAudio(); checkKeepAudio(); }
    }

    // ============================================================
    //  13/b. TICKER: A BACKGROUND TAB'S TIMERS GET THROTTLED
    // ============================================================
    // MEASURED (Chrome, hu27, hidden tab, 2×7 minutes):
    //
    //   source                    visible tab   hidden tab (worst gap)
    //   setInterval(1000)             1.0 s         60.0 s
    //   setTimeout chain              1.0 s         60.0 s
    //   Web Worker setInterval        1.0 s          1.0 s
    //   <audio> 'timeupdate'             --          0.27 s
    //
    // So the tab's own timers collapse to once a minute ("intensive throttling"),
    // and the QUIET LOOP DOES NOT HELP with that: the second run was measured with
    // the audio provably playing, and setInterval still woke only every 60 s. The
    // audio defends against FREEZING, not against throttling -- separate problems.
    //
    // What throttling does not cover: a dedicated Web Worker's timer, and media
    // playback's own events. So we tick in three layers:
    //
    //   1. Web Worker  -- the primary source, always running, once a second.
    //   2. the quiet loop's 'timeupdate' event -- for when the worker won't start
    //      (a strict CSP can forbid blob: workers), and there is work waiting.
    //   3. the tab's own setInterval -- last resort, once a minute when hidden.
    //
    // The worker only SIGNALS, all the logic stays on the main thread (it couldn't
    // reach the game's API anyway). All three sources call the same `tick`, and
    // the time of the last run decides whether to work -- so they never double up.
    let tickWorker = null;
    let lastWatchAt = 0;
    let lastLeaderAt = 0;
    let lastTickAt = Date.now();
    // Tick health: without it we would only be guessing whether the defence works.
    const tickHealth = { worstVisible: 0, worstHidden: 0, lastGap: 0, source: '-', stalls: 0 };

    function createTickWorker() {
        try {
            if (typeof Worker !== 'function' || typeof Blob !== 'function') return null;
            const src = 'setInterval(function(){postMessage(0)}, ' + CONFIG.WATCH_INTERVAL + ');';
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            const w = new Worker(url);
            URL.revokeObjectURL(url);
            return w;
        } catch(e) {
            console.warn('[Lisa] No worker ticker, falling back to the tab timer:', e);
            return null;
        }
    }

    function recordTickGap(now) {
        const gap = now - lastTickAt;
        lastTickAt = now;
        tickHealth.lastGap = gap;
        if (isVisible()) tickHealth.worstVisible = Math.max(tickHealth.worstVisible, gap);
        else tickHealth.worstHidden = Math.max(tickHealth.worstHidden, gap);
        if (gap >= CONFIG.TICK_STALL_WARN) {
            tickHealth.stalls++;
            // Only interesting if there was something to do meanwhile.
            if (extraJobs.length > 0) {
                console.warn(`[Lisa] The ticker skipped ${Math.round(gap / 1000)}s `
                    + `(${isVisible() ? 'visible' : 'hidden'} tab, source: ${tickHealth.source}).`);
            }
        }
        return gap;
    }

    // CATCHING THE GAME CLIENT UP -- this is what makes a background tab usable.
    //
    // The game works off its own MAIN-THREAD timers (read out of the bundle):
    //
    //   window.setInterval(TaskQueueUi.tick, 1000)      -- retiring a finished task
    //   new Ticker(Character.tick4Character).setPeriod(2000) -- energy/health regen
    //
    // In a hidden tab both are throttled to once a minute (measured), and on top
    // of that TaskQueueUi.tick retires ONLY ONE task PER CALL: it looks at queue[0]
    // only and returns right after TaskQueue.finish(task). That is why the queue
    // sticks at its pre-freeze state, while the server finished the jobs long ago.
    //
    // This is where "a 15-second job runs every 2-3 minutes in the background" came from:
    //   - the free-slot count comes from the stuck queue length, so we never sent,
    //   - and TaskQueue.add gates its OWN limit on that stuck length as well
    //     (taskLimit < queue.length + tasks.length -> silently truncates), so even
    //     computing the free slots correctly ourselves wouldn't get them accepted.
    // The same was visible before this script existed: come back to the tab and the
    // four jobs "count down to zero", then vanish one by one over 2-3 seconds -- the
    // tick works off the backlog at 1 Hz, one task per call.
    //
    // The fix is not in our own scheduling: we call the GAME'S OWN functions from
    // our worker-driven tick. We do nothing on their behalf, we only run them at
    // the rate the game intends for them anyway.
    function pumpGameClient() {
        const ui = window.TaskQueueUi;
        if (!ui || typeof ui.tick !== 'function') return false;
        // Don't touch the queue while a batch (ours or the game's) is in flight.
        if (processing || (window.TaskQueue && window.TaskQueue.busy)) return true;

        // The game recomputes the energy too. Without this Character.energy stays at
        // its lower, pre-freeze value, and the energy pre-check would wait for a
        // regeneration that has in fact already happened.
        try {
            const c = window.Character;
            if (c && typeof c.tick4Character === 'function') c.tick4Character();
        } catch(e) {}

        // One task comes out per call, so we keep calling while the queue keeps
        // shrinking. The bound is the queue length: it can't hold more finished tasks.
        let guard = gameQueueLimit() + 1;
        while (guard-- > 0) {
            const before = gameQueueLength();
            try { ui.tick(); } catch(e) { break; }
            if (gameQueueLength() >= before) break;      // nothing more had finished
        }
        return true;
    }

    // Every tick lands here, whatever its source.
    function tick(source) {
        const now = Date.now();
        // The faster source wins; the other one then does nothing.
        if (now - lastWatchAt < CONFIG.WATCH_INTERVAL * 0.6) return;
        tickHealth.source = source;
        const gap = recordTickGap(now);
        lastWatchAt = now;

        // FIRST thing: catch the game client up. Every decision below it (free slots,
        // energy, ETAs) reads from the game's state.
        const pumped = pumpGameClient();

        // If we couldn't pump the game (no TaskQueueUi), the old caution stands:
        // after a long gap we give it a round's grace before basing anything on
        // the queue's state.
        if (!pumped && gap >= CONFIG.LONG_GAP_MS && nextJobTimer
            && nextJobDeadline < now + CONFIG.LONG_GAP_SETTLE_MS) {
            scheduleNextJob(CONFIG.LONG_GAP_SETTLE_MS);
        }

        if (now - lastLeaderAt >= CONFIG.LEADER_HEARTBEAT) {
            lastLeaderAt = now;
            refreshLeadership();
        }
        watchGameQueue();
        pumpNextJobTimer();
    }

    // Tab switch, window raised, machine wake, network back: after each of these we
    // catch up at once instead of waiting for the next tick. We do NOT pull the
    // deadline in -- this must not override an in-flight backoff (after a
    // rejection).
    function catchUpNow(reason) {
        lastWatchAt = 0;
        tick(reason);
    }

    function startTicker() {
        lastWatchAt = lastLeaderAt = 0;
        lastTickAt = Date.now();
        tickWorker = createTickWorker();
        if (tickWorker) {
            tickWorker.onmessage = () => tick('worker');
            tickWorker.onerror = (e) => {
                console.warn('[Lisa] The worker ticker went quiet, falling back:', e && e.message);
                try { tickWorker.terminate(); } catch(err) {}
                tickWorker = null;
            };
            console.log('[Lisa] Worker ticker active (one second even in a background tab).');
        }
        // Fallback: without a worker this is the only source, and alongside one it
        // steps in if the worker ever goes quiet.
        setInterval(() => tick('timer'), CONFIG.WATCH_INTERVAL);
    }

    function tickHealthText() {
        const w = tickHealth.worstHidden;
        return `Ütemadó: ${tickWorker ? 'worker' : 'fül-időzítő'} (${tickHealth.source})`
            + ` · legrosszabb kihagyás rejtett fülön: ${(w / 1000).toFixed(1)} mp`
            + ` · látható fülön: ${(tickHealth.worstVisible / 1000).toFixed(1)} mp`
            + ` · ${keepAwakeStatus()}`;
    }

    // Queryable from outside, so the user can see what the defence is worth.
    window.lisaDiag = () => ({
        version: '12.14',
        visible: isVisible(),
        focused: document.hasFocus(),
        ticker: tickWorker ? 'worker' : 'tab-timer',
        lastSource: tickHealth.source,
        lastGapSec: +(tickHealth.lastGap / 1000).toFixed(1),
        worstVisibleSec: +(tickHealth.worstVisible / 1000).toFixed(1),
        worstHiddenSec: +(tickHealth.worstHidden / 1000).toFixed(1),
        stalls: tickHealth.stalls,
        gamePump: (window.TaskQueueUi && typeof window.TaskQueueUi.tick === 'function')
            ? 'active' : 'UNAVAILABLE (the queue can stall in the background)',
        // Hungarian: this is the same text the panel's status line shows as a tooltip.
        keepAwake: keepAwakeStatus(),
        waitingJobs: extraJobs.length,
        leaderTab: isLeaderTab,
    });

    // ============================================================
    //  14. MULTIPLE TABS: A SINGLE PROCESSOR
    // ============================================================
    // Two open game tabs used to send from the same list in parallel.
    // The leader tab writes a heartbeat into localStorage; the rest follow passively.
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
            // A VISIBLE tab may always take the lead from a background one: that is where
            // the user is waiting for the work. Without this, a forgotten background tab
            // silently blocked processing in the tab the user was looking at -- and the UI
            // only said "passive tab".
            const canTakeOver = visible && cur && !cur.visible;

            if (stale || mine || canTakeOver) {
                localStorage.setItem(CONFIG.STORAGE_LEADER, JSON.stringify({ id: TAB_ID, ts: now, visible }));
                isLeaderTab = true;
            } else {
                isLeaderTab = false;
            }
        } catch(e) {
            isLeaderTab = true; // no usable storage: we're on our own
        }

        if (isLeaderTab && !wasLeader) {
            console.log('[Lisa] This tab took over processing.');
            ensureProcessing();
        } else if (!isLeaderTab && wasLeader) {
            console.log('[Lisa] Another, visible tab took over processing.');
        }
        // The leader should schedule too, if there is work and no timer is pending.
        if (isLeaderTab) ensureProcessing();
    }

    // The game's queue can also shorten from the outside: a job finishes, or the
    // user cancels one. We then don't sit out the previously scheduled wait --
    // which can be minutes long -- but start the next one within a few seconds.
    // We act ONLY on a DECREASE in the queue length, so if the game does refuse
    // the start, we don't begin retrying every two seconds.
    function watchGameQueue() {
        ensureMenuButton();
        patchHotelStart();      // the hotel window may load later too
        updateQueueBadge();
        updateExtraEtas(refreshForecast());
        updateEnergyForecastBar();
        offerSleepIfForecastRunsOut();
        updateKeepAwake();
        askRunningSleepMode();
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
            console.log(`[Lisa] A slot freed up (${len}/${gameQueueLimit()}), starting shortly.`);
            scheduleNextJob(CONFIG.SLOT_FREED_DELAY);
        }
    }

    function releaseLeadership() {
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_LEADER);
            const cur = raw ? JSON.parse(raw) : null;
            // Release only our own, so another tab can take over at once instead of
            // waiting out the TTL.
            if (cur && cur.id === TAB_ID) localStorage.removeItem(CONFIG.STORAGE_LEADER);
        } catch(e) {}
    }

    function initTabSync() {
        refreshLeadership();
        // From here the ticker drives the heartbeat (startTicker), so it isn't
        // throttled to once a minute in a background tab: otherwise a slowed leader
        // would let its own TTL lapse, and the tabs would take the lead from each other.

        // On a tab switch we re-evaluate at once, we don't wait for the heartbeat.
        // The browser releases the screen wake lock on hide, so it has to be requested
        // again on show -- without that it stops protecting after the first tab switch.
        document.addEventListener('visibilitychange', () => {
            refreshLeadership();
            if (isVisible()) {
                requestWakeLock();
                // If the element was born in a hidden tab, now it has a chance to load.
                ensureKeepAudioElement();
            }
            catchUpNow('visibility');
        });
        // Window raised, machine wake, network back, restored from bfcache: after each
        // of these we are behind, so we catch up at once.
        window.addEventListener('focus', () => { requestWakeLock(); catchUpNow('focus'); });
        window.addEventListener('pageshow', () => catchUpNow('pageshow'));
        window.addEventListener('online', () => catchUpNow('online'));
        // Release leadership on close: a closed tab used to hold it until the TTL ran out.
        window.addEventListener('pagehide', () => { releaseLeadership(); releaseWakeLock(); });
        // The browser may block autoplay until the first user gesture (Safari is
        // stricter about this), so we retry on several kinds of gesture -- all of
        // which occur in the game.
        const nudge = () => { if (keepAwakeWanted) startKeepAudio(); };
        ['click', 'pointerdown', 'keydown', 'touchstart'].forEach(
            ev => document.addEventListener(ev, nudge, true));

        // The storage event only fires in the OTHER tabs, so it always signals a
        // foreign change. Every tab reloads -- the leader too, otherwise its next
        // save would overwrite work added in a passive tab.
        window.addEventListener('storage', (e) => {
            if (!e.key) return;
            if (e.key === CONFIG.STORAGE_EXTRA_QUEUE) {
                const data = loadStore(CONFIG.STORAGE_EXTRA_QUEUE);
                if (data) {
                    extraJobs = sanitizeJobs(data);
                    updateExtraList();
                    ensureProcessing(CONFIG.NEW_WORK_DELAY);
                }
            } else if (e.key === CONFIG.STORAGE_HISTORY) {
                loadHistoryFromStorage();
            }
        });
    }

    // --- Menu bar button ---
    // ============================================================
    //  THE PANEL: IN THE GAME'S OWN WINDOW FRAME
    // ============================================================
    // wman is the game's window manager: wman.open(uid, title) gives a real game
    // window with a frame, a title bar, minimize/close buttons and drag-to-move.
    // So the panel looks and behaves exactly like any other window, instead of
    // us imitating a frame ourselves.
    //
    // Two background layers need adjusting, because they run out on a tall window:
    //  - .tw2gui_window_inset carries the parchment (natural 721x420, no-repeat,
    //    anchored bottom-left); above it the top of the frame would stay bare;
    //  - .tw2gui_inner_window_bg2 is the 32x420 right-hand edge strip, which may
    //    only be stretched VERTICALLY, or it smears into a wide dark band.
    // Both overrides are scoped to our own window's class.
    function injectPanelStyles() {
        if (document.getElementById('lisa-panel-style')) return;
        const st = document.createElement('style');
        st.id = 'lisa-panel-style';
        st.textContent = `
            #lisa-body { display: flex; flex-direction: column; height: 100%; font-family: Georgia,'Times New Roman',serif; }
            /* The status line splits in two: the message on the left, the whole list's
               predicted end on the right, so the summary costs no extra row of height. */
            #lisa-status {
                display: flex; align-items: baseline; gap: 6px; flex: 0 0 auto;
                font: italic 11px Georgia,serif; color: #4a3b28; padding: 1px 20px 3px 4px;
            }
            #lisa-status-text { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #lisa-total-eta {
                flex: 0 0 auto; font-style: normal; font-weight: bold; color: #3b2f1e;
                font-variant-numeric: tabular-nums; white-space: nowrap;
            }
            /* Dark edge decorations run down both sides of the frame. We inset the list
               so neither the text nor the remove ✕ sits on them. */
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
            /* Declined but still available: same row, no longer shouting. */
            #lisa-sleep-offer.lisa-offer-quiet {
                background: rgba(170,90,30,0.07); border-color: #8a7048; color: #5c4a30;
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

    // The window is deliberately short; whatever doesn't fit is reachable by
    // scrolling. Going taller isn't worth it: the parchment background's natural
    // height is 420 px, above which the top of the frame would stay bare.
    function panelHeight() {
        return Math.max(170, Math.min(CONFIG.PANEL_HEIGHT, window.innerHeight - 180));
    }

    function applyPanelGeometry(win) {
        try { win.setSize(CONFIG.PANEL_WIDTH, panelHeight()); } catch(e) {}
        const el = document.querySelector('.' + CONFIG.WINDOW_ID);
        if (!el) return;
        // The panel's original spot: top right corner, below the map.
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

    // Idempotent. wman.close() destroys the window entirely (getById returns
    // nothing afterwards) and reopening yields an EMPTY content pane -- so the
    // content must always be rebuilt when it is missing.
    function ensurePanel() {
        injectPanelStyles();
        let win = panelWindow();
        if (!win || !document.querySelector('.' + CONFIG.WINDOW_ID)) {
            try {
                win = wman.open(CONFIG.WINDOW_ID, 'Extra Queue');
            } catch(e) {
                console.error('[Lisa] Could not open the game window:', e);
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

    // The sleep offer lives in the panel, not in a popup: the game's own dialogs
    // are about the queue, and a stray click there is expensive.
    function renderSleepOffer() {
        const box = document.getElementById('lisa-sleep-offer');
        if (!box) return;
        if (!sleepOffer) {
            box.style.display = 'none';
            box.textContent = '';
            box.className = '';
            return;
        }
        box.textContent = '';
        box.style.display = '';
        // A declined offer stays, but it must not keep shouting: same row, muted.
        box.className = sleepOffer.declined ? 'lisa-offer-quiet' : '';
        const text = document.createElement('span');
        const at = sleepOffer.at || 0;
        const rest = typeof sleepOffer.total === 'number' && sleepOffer.total > 0
            ? ` (még ${sleepOffer.total} kell)` : '';
        const question = sleepOffer.declined ? '' : ' Alvás?';
        text.textContent = at > 0
            ? `A(z) ${at + 1}. munkára elfogy az energia${rest}.${question}`
            : `Kevés az energia${rest || ` (${sleepOffer.needed} kell)`}.${question}`;
        text.title = 'A jóslat szerint innentől nem lenne indítható a munka.'
            + (rest ? ` A hátralévő munkák teljes energiaigénye: ${sleepOffer.total}.` : '');
        const where = at > 0 ? `a(z) ${at + 1}. munka elé` : 'a sor elejére';

        // Declined: one button back to the choices. The offer keeps updating in the
        // background, so whenever the user does come back the numbers are current.
        if (sleepOffer.declined) {
            const again = document.createElement('button');
            again.textContent = 'Alvás…';
            again.title = `Mégis alszom – az alvás beszúrása ${where}`;
            again.addEventListener('click', reopenSleepOffer);
            box.appendChild(text);
            box.appendChild(again);
            return;
        }

        const yes = document.createElement('button');
        yes.textContent = 'Teljes';
        yes.title = `Alvás beszúrása ${where}, a szoba teljes szintjéig`;
        yes.addEventListener('click', () => { const i = at; dismissSleepOffer(false); insertSleepJob(i, 'full'); });
        const enough = document.createElement('button');
        enough.textContent = 'Amennyi kell';
        enough.title = `Alvás beszúrása ${where}, de csak amíg a hátralévő munkákhoz elég energia gyűlik`;
        enough.addEventListener('click', () => { const i = at; dismissSleepOffer(false); insertSleepJob(i, 'enough'); });
        const no = document.createElement('button');
        no.textContent = 'Nem';
        no.title = `Most nem – ${Math.round(CONFIG.SLEEP_DECLINE_MS / 60000)} percig nem kérdezünk újra`;
        no.addEventListener('click', () => dismissSleepOffer(true));
        box.appendChild(text);
        box.appendChild(yes);
        box.appendChild(enough);
        box.appendChild(no);
    }

    // After a reopen the status line would show the placeholder; print the real state.
    function refreshIdleStatus() {
        updateUIStatus(
            paused ? 'Szüneteltetve'
            : !isLeaderTab ? 'Passzív fül – egy másik, látható fül dolgozza fel a sort.'
            : extraJobs.length ? `${extraJobs.length} munka várakozik.`
            : 'Kész.');
    }

    // In wman, minimizing is HIDING the window's main div (fadeOut) plus an entry
    // in wman.minimizedIds. In that state bringToTop() does nothing on its own --
    // the panel "won't open" from the menu button either. The game uses
    // wman.reopen for this: it fades the window back in and clears the minimized
    // state as well.
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
            console.warn('[Lisa] Could not bring the panel to the front:', e);
        }

        // Last resort: if anything else left it hidden or pushed it off-screen (saved
        // appearance, resized window), make it usable again.
        const el = document.querySelector('.' + CONFIG.WINDOW_ID);
        if (!el) return;
        if (getComputedStyle(el).display === 'none') el.style.display = 'block';
        const r = el.getBoundingClientRect();
        const offScreen = r.right < 40 || r.bottom < 40
            || r.left > window.innerWidth - 40 || r.top > window.innerHeight - 40;
        // We respect where the user dragged it; we only put it back if it would
        // otherwise be unreachable.
        if (offScreen) applyPanelGeometry(win);
    }

    // A reopen button in the menu bar, under the gear icon -- wman's ✕ closes the
    // window completely, and without this there would be no way back.
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

    // Rows are bound by id, not by array index: the processor can take a job off
    // the front of the list at any moment between the render and the click, and
    // then the index would point at something else.
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

    // The right edge of the status line shows the WHOLE list's predicted end: the
    // finish of the chain's last job. This is the most common question ("when will
    // it all be done?"), and per-job times can't be summed by eye -- travel counts too.
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
        // If the travel time couldn't be computed the estimate is incomplete -- flag it.
        uiTotalEta.style.opacity = last.estimated ? '1' : '0.55';
    }

    // One row's warnings and energy forecast. Motivation drops when the job
    // COMPLETES, so what shows here is the value predicted for its START -- the
    // question being "how much motivation will it set out with".
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

    // Rewrites only the time strings, it doesn't rebuild the rows: so it can
    // refresh many times a minute without constantly redrawing the list.
    // The forecast refreshes INDEPENDENTLY of the panel: the energy bar in the
    // character box shows even while the panel is closed or minimized.
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
            // Flag it as an estimate if the travel time couldn't be computed.
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
        // Decide the leader before any processing, so a second tab doesn't start
        // sending straight away.
        initTabSync();
        loadExtraQueueFromStorage();
        loadHistoryFromStorage();
        loadSleepDecision();
        // Write back to the new key, otherwise we would migrate from the old one on
        // every start and the normalized form would never settle.
        saveHistoryToStorage();
        ensurePanel();
        ensureMenuButton();
        updateUI();
        updateUIStatus(isLeaderTab
            ? 'Kész.'
            : 'Passzív fül – egy másik, látható fül dolgozza fel a sort.');
        initAmountPatch();
        // The game's queue also changes from the outside (a job finishes, the user
        // cancels one), so we look in on it regularly.
        lastSeenQueueLen = gameQueueLength();
        // Create the loop element NOW, not at the first job: the browser never even
        // starts loading a media element born in a hidden tab, and the typical use is
        // exactly that the user queues things up and then puts the browser away. We
        // load it but don't play it -- playback only starts once there really is work
        // waiting.
        ensureKeepAudioElement();
        startTicker();
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
                // Without this the poll ran for the page's lifetime if the UI never appeared.
                clearInterval(checkDOM);
                console.warn('[Lisa] The game UI never showed up, the script will not start.');
            }
        }, 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDOMReady);
    else onDOMReady();

    console.log('[Lisa] Modular v12.14 loaded.');
})();
