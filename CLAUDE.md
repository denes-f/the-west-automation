# The-West Modular Job Queue (Lisa)

Tampermonkey userscript for the browser game **The West** (Hungarian servers, `*.the-west.hu`).
The game's own job queue holds 4 tasks (9 with premium). This script keeps an **extra queue** of
jobs beyond that limit and feeds them in as slots free up.

- `the-west-automation.js` — the whole userscript, single IIFE, no build step.
- `test-queue.js` — `node test-queue.js`. Extracts the real functions out of the userscript by
  name and runs them against stubs. 334 assertions, no dependencies.
- `smoke-load.js` — `node smoke-load.js`. Runs the *whole* IIFE in a stubbed browser and checks
  `lisaDiag()` came up. `test-queue.js` pulls functions out by name, so it cannot see a script that
  fails to load at all (typo'd global, `const` in the temporal dead zone, missing browser API) —
  that would show up live as an empty panel. Run this one first.

The user installs the script by pasting it into Tampermonkey. There is no deploy step, so after
any change ask them to reinstall before testing live.

**Current release: v12.16.** Feature-complete and in daily use. The behaviour below is all verified;
treat it as the baseline rather than something to redesign.

## Picking up a new session

0. The test account for `hu27` is in `local-notes.md` (**gitignored** — the repo has a GitHub
   remote, so no credentials in tracked files). The browser session is usually still signed in,
   so entering the world needs no password.
1. Read this file first — the game facts below cost many live browser sessions to establish.
2. `node test-queue.js` should print `334 passed, 0 failed`.
3. For anything touching the game, open one tab and measure. Do not reason from the code alone;
   the code is right *because* of these measurements, not the other way round.
4. Close your tab when finished and say what energy you spent.

## What the script does

- Intercepts **both** ways to start a job — the job window's start buttons and the map's quick-start
  arrows — and puts the whole batch at the end of its own `extraJobs` list.
- Feeds jobs into the game's queue as slots free, always in FIFO order.
- Shows a **third status bar** under the character's own energy bar with the energy predicted for
  the end of the waiting list — same sprite, faded. It updates every second even when the panel is
  closed, so recovered energy is reflected as it happens.
- Warns per job when the **motivation** at its predicted start would be ≤ 75%, or when the
  **energy** won't cover its cost — and offers to insert a **sleep** (never unasked, never a paid
  room), ending it once that sleep's goal is met: the room's level, or just enough for the jobs
  behind it, whichever the user chose for that sleep.
- Shows waiting jobs in **two places**: its own game-style window (top right, scrollable) and as
  extra rows in the game's bottom-right queue widget, under a separator (5 shown, then a `+N` tile
  in the sixth slot).
- Shows predicted start→finish times per job, chaining travel between locations.
- Clears the waiting list when the user confirms the game's "cancel all".

## Ground rules learned the hard way

**Never guess the game's API or DOM — go and look.** Two separate bugs shipped because a response
format was assumed rather than observed, and both silently destroyed the user's queued jobs. Every
game-facing fact below was measured in a live browser session. If you need a new one, measure it too.

**Never remove a job from `extraJobs` before the game has accepted it.** `processQueue` peeks at
the head of the list and only splices after `TaskQueue.queue.length` actually grew. This is what
structurally prevents the "jobs vanished" class of bug — keep it that way. Note the length check
alone is *not* sufficient: the server can still reject afterwards, so the add response is the real
verdict (see "Add response shape"). Both halves are needed.

**Energy is a real cost.** Every started job spends the character's energy. Test with 15-second
jobs, cancel afterwards (cancelling refunds part of it), and prefer read-only probing. Say what
you spent.

**Only one game tab.** A second tab holding the leader lock is what made v11.0 look completely
broken. Close your own tab when finished.

## State of play (end of the v12.13 session)

Everything is committed and pushed on `dev`; `main` is at v12.0 and has not been moved since.
The user runs the script on two accounts: the `hu27` test character (level 10, max energy 100, in a
town, nothing else installed) and a **main account** that has the energy bonus (max 150) and the
*twdb* userscript adding a duel-motivation bar. Several bugs only appeared on the main account —
when something looks fine on the test character, that is not proof.

Verified **live in the game**: the panel and its window behaviour, the `+N` tile, the injected rows
and their forced visibility, the travel-rate formula, motivation and energy-cost reads, the energy
regeneration formula, the forecast bar's placement and appearance (including alongside *twdb*), all
three dialogs' rendering, and cancelling a running sleep.

Also confirmed live by the user in v12.9: the running-sleep dialog, the `'enough'` mode and its
live-recalculated goal (queueing more jobs mid-sleep moved the wake-up correctly).

Measured live in v12.11–12.12 on the game page itself: the background-tab throttling table under
"Keep-awake", that `the-west.hu` permits `blob:` Web Workers, and the `pumpGameClient` A/B (control
vs pump in the same hidden, throttled tab) under the same section. **The worker ticker alone did
not fix background throughput** — the user reported ~2.2 min per 15 s job in Safari with
`ticker: "worker"` and a 3.0 s worst gap. That is what led to the game-client staleness, which was
the real cause.

Confirmed live by the user in v12.11: the worker ticker runs in **Safari** too (`ticker: "worker"`,
worst hidden-tab gap 3.0 s — coarser than Chrome's 1.0 s but far from 60 s).

**v12.12 was tested end-to-end in a real game session** (Chrome, installed build, jobs started
through the job window so the script's own interception ran): `ticker: "worker"`,
`gamePump: "active"`, and the 4.0 jobs/minute hidden-tab result recorded under "Keep-awake".
The `hang: elakadt` the user saw in Safari turned out to be **two separate bugs of mine**, both
reproduced and fixed in v12.13 — the `currentTime` aliasing false positive, and the genuinely
never-loading element created in a hidden tab. Both are written up under "Keep-awake".

Verified **only by unit tests**, never yet exercised end-to-end in a real game: the rejected-job
requeue path — its trigger was reproduced live, but the recovery was written afterwards. Worth
watching the first time it fires for real. Also v12.13 itself: the sleep-position fix and the two
audio fixes have unit tests and were each measured in the page by hand, but the assembled build has
not run a full game session — check `keepAwakeStatus()` reports `hang: szól` (not `nem töltődött
be`) once jobs are queued. **v12.14 (the persistent sleep offer) is in the same state**: 20 unit
tests cover the state machine, but the collapsed row has never been seen in the game. Worth one
look — decline an offer and check the row stays, keeps its numbers current, expands on `Alvás…`,
and disappears by itself once the energy recovers.
**v12.15 (energy paid at hand-over, ETAs pushed out by the energy wait) is also in this state**: the
*symptom* was reported live from the main account with exact numbers, and the client-side formula
was re-read out of the bundle, but the new forecast has only run against unit tests. Worth one look
at a list the energy can't keep up with — the ⚠ should sit on the first job that has to wait (and on
that one only), the row tooltip should say how much of the delay is the energy, and the ⚡ figure
should never promise energy the game will already have taken.

**Verified live in the game, v12.16** (hu27, installed build, one session, 5 energy net):
the walk diversion (queue at 4/4, `TaskQueue.add(new TaskWalk(...))` → the game's queue stayed at 4
and the walk appeared in our list instead of vanishing); our tiles being `<div>`s, so
`$('#queuedTasks span').length` returned only the game's own 4; the collapse fix (after
`TaskQueueUi.toggleTasks()` the widget stayed folded through 5 s of watcher ticks — it used to be
forced back open every second); the release path with real tasks still queued (inline style handed
back, `(unset)`) and with the queue emptied (no stray element, everything at zero height); and the
new `⚡A → B` row.

**A caveat about testing the toggle**: `$('#toggleTaskQueue').click()` does *not* reach the handler.
Call `TaskQueueUi.toggleTasks()` instead — that is the function the arrow ends up in.

Still verified **only by unit tests** after v12.16: the space-budgeted preview (`previewForSpace`)
was never seen against a list long enough to hit the cap, since the test character has 4 slots and
no premium. That one needs the main account.

Not measured, deliberately: motivation regeneration (believed to reset daily, hour unknown — the
5-minute re-read makes this self-correcting; see the note under the architecture section).

## Browsers

Chrome is the reference and the only browser anything has been measured in. The script is written
to work in Safari too (Tampermonkey for Safari, or the *Userscripts* extension — the header carries
both `@include` and `@match` for that reason), but **nothing below is verified there**:

- `navigator.wakeLock` needs Safari 16.4+; the call is feature-guarded, so an older Safari simply
  loses the screen lock and keeps everything else.
- Safari's autoplay policy is stricter than Chrome's, which is why the audio retries on four
  different gesture types and `checkKeepAudio` re-checks that it actually started.
- Safari throttles and can outright suspend background tabs, on its own schedule. Whether its Web
  Worker timers survive that the way Chrome's do is **unknown** — measure it with `lisaDiag()`
  before assuming the ticker helps there.
- The blob-Worker CSP check was done on Chrome only.

## Verified facts about the game

Measured on `hu27.the-west.hu` (Red Rock), character level 8.

### Queue and starting jobs

- `TaskQueue.queue` — live array of queued tasks. **Authoritative**; never model it separately.
- `TaskQueue.limit` — `{normal: 4, premium: 9}`. Which one applies: `Premium.hasBonus('automation')`.
- `TaskQueue.add(tasks)` — accepts a **single task or an array**, updates `queue` **synchronously**,
  and when full it **refuses silently and sends no request**. So "how many were accepted" is just
  the change in `queue.length`.
- `new TaskJob(jobId, x, y, duration)` — the constructor signature. Duration in seconds.
- Queue entries: `.post = {jobId, x, y, duration, taskType}`, `.data.date_done` in **milliseconds**
  (the add *response* uses seconds — don't mix them up), `.queueId`, `.queuePos`.
  `.post` is set by the `Task` base class, so every entry has it whatever created it.
- An **unqueued** `new TaskJob(...)` already answers `getIcon()` (an image URL) and `getTitle()`.

Always start jobs through `TaskQueue.add`, never raw XHR. Raw XHR reaches the server but leaves the
game client unaware — the job runs but never appears in the bottom-right queue UI.

### Add response shape

```json
{"tasks":[{"task":{"queue_id":…,"date_done":1785828704.77,"data_obj":{…}}}],"energy":91.78,…}
```

`tasks[i].task.date_done` — note the wrapper. `tasks` holds the tasks **added by this request**,
not the whole queue. Errors are `{"error":true,"msg":"…"}`. A bare `msg` with no `error` is **not**
a success — assuming it was is what ate three jobs.

**`tasks[]` is per-task and mixed**: the i-th element answers the i-th task of the request, and is
either `{"task":{…}}` or `{"error":true,"msg":"…"}`. Measured rejection (job requiring level 53
started at level 9):

```json
{"tasks":[{"error":true,"msg":"Legalább a 53 szintet kell elérned…"}],"energy":97.2,…}
```

**This is a live data-loss hazard.** `TaskQueue.add` pushes **synchronously**, so `queue.length`
grows and the script counts the jobs as accepted — but a few seconds later the server rejects them,
the game removes them from the queue, and the jobs are already gone from `extraJobs`. Verified:
8 seeded jobs, all silently lost, with the panel reporting "all started". The synchronous
length check alone is **not** proof of acceptance; only the response is.

### Durations

`JobList.getDurations()` → `{short:{duration:15,requirement:1}, middle:{duration:600,requirement:10},
long:{duration:3600,requirement:20}}`. So 15 s, 10 min, 1 hour, unlocked at levels 1/10/20.

The job window has **three duration bars**, each `.job_durationbar` with `data-base="short|middle|long"`,
and **each holds its own `.job_startbutton`**. At low level only the short bar has one, which hides
the trap: taking "the first non-disabled bar" silently returns 15 s for every job on a high-level
account. Read the duration from the bar containing the **clicked** button, mapping `data-base`
through `getDurations()`. The amount selector (`.job-amount-num`) is **outside** the bars and shared.

Bar duration text is compact — `15mp`, `10p`, `1ó` — but prefer `data-base`; text parsing is fallback only.

### Motivation and energy cost per job (read-only, no energy spent)

One call answers both, for a given job at a given place:

```js
Ajax.remoteCallMode("job", "job", {jobId, x, y}, json => …)
```

- `json.motivation` — **0…1**, so ×100 for percent. The job window itself does
  `parseInt(json.motivation * 100)`. Measured 1 → 0.9 after ~10 completed 15 s jobs of that job.
- `json.durations[]` — one entry **per unlocked duration**, each `{duration, cost, money, xp, luck,
  items}`. **`cost` is the energy cost** (1 for the 15 s bar at level 9; the 5 / 12 of the 10 min and
  1 h bars only appear once those are unlocked). This is the authoritative source — don't hardcode.
- Motivation drops by the job's energy cost when the job **completes**; energy is deducted when the
  job **enters the game's queue** and refunded if it is cancelled before completing.
- `EventHandler.signal('jobmotivation_change')` fires when motivation changes.

### Energy regeneration — exact formula from the game

`Game.tick4Character` computes, verbatim:

```js
energy = min(maxEnergy, floor(energy + maxEnergy * energyRegen * (serverTime - energyDate) / 3600))
```

- `Character.energy`, `Character.maxEnergy` (100; 150 with the bonus), `Character.energyRegen`
  (measured **0.03**), `Character.energyDate` (server time in **seconds**, the anchor of the above),
  `Game.getServerTime()` → seconds.
- So the rate is `maxEnergy * energyRegen` per hour = **3/h at 100 max**, and it scales by itself
  with a 150 max — never hardcode 2 or 3.
- `Character.levelEnergyFillup` is `true`: **levelling up refills energy completely**, which will
  make any forecast jump. Confirmed live (96 → 97 mid-test).
- Re-read out of the bundle in v12.15 (`curl https://hu27.the-west.hu/cache/tw2game.hu_HU.js`, no
  login needed — a fast way to check a game fact without spending a browser session): `maxEnergy *
  energyRegen` is the **only** energy rate anywhere in the client. `Game.tick4Character` and
  `WestUi.updateEnergy` both use it verbatim, so the bar the player sees and our forecast cannot
  disagree. `setEnergy(e, energyDate)` re-anchors `energyDate` to *now* on every actual change (and
  **returns early without re-anchoring when the value is unchanged**, which is what keeps the
  accumulation correct); the optional second argument is a **relative offset in seconds**, used only
  by the chat's user-update path.
  **Open question:** whether `energyRegen` really stays 0.03 at `maxEnergy` 150 (⇒ 4.5/h) or the
  server sends a smaller factor to keep 3/h. Reading the live pair on the main account settles it;
  either way the code is right, because it reads both from the game.
- **Measured against the SERVER, v12.16** (hu27, level 10, max 100, `energyRegen` 0.03). The client
  is only ever an extrapolation from `energyDate`, so the authoritative value has to come off the
  wire — the add response carries a **fractional** `energy`, which is the only high-resolution
  reading available (`Ajax.remoteCallMode("job","job",…)` carries none, and a job **completing**
  sends no energy field and does **not** re-anchor `energyDate`).

  | | |
  | --- | --- |
  | server energy at the anchor | 80.00004 |
  | 19.87 min later, after paying 1 for a new job | 79.9938 |
  | ⇒ observed | 0.9938 in 19.87 min = **3.001/h** |
  | client claimed | **3.00/h** |

  Two conclusions. **Energy regenerates while the character is working, at the full rate** — jobs
  ran for the entire 19.87 minutes. And the **server agrees with the client's formula to three
  decimals**, so the rate is not somewhere a wrong forecast can come from. If a forecast looks too
  generous on the main account, check `energyRegen` × `maxEnergy` there first: 0.03 at 150 really is
  4.5/h, i.e. half again the test character's rate.
  Method, for repeating it: record `energy` out of every XHR response that carries one, anchor on an
  add response, wait, then start one 15 s job and read the next add response. Two fractional values
  and the known cost in between give the rate outright — no hour-long observation needed.

### Sleeping

- `TaskQueue.add(new TaskSleep(townId, room))` — same path as jobs; this is exactly what the
  hotel window's start button does (`HotelWindow.start`).
- `room` ∈ `['cubby','bedroom','hotel_room','apartment','luxurious_apartment']` (ordered worst→best,
  the index picks the icon).
- `sleep.onCancel(extra)` applies `extra.energy` — cancelling a sleep syncs the real energy back,
  so "cancel when full and move on" is supported by the game itself.
- `Character.homeTown` → `{town_id, x, y, town_name, alliance_id}`; `town_id` is **0** when the
  character has joined no town.
- `Ajax.remoteCallMode("building_hotel", "get_data", {town_id})` → `rooms[key] = {level, costs,
  energy, health, name, available, free}`. **`energy` is the level sleeping there fills up to**,
  and everything is `free: true` in the character's own town. Never auto-pick a room that isn't
  free — that spends the user's money.
  The level is **a fixed fraction of the character's maximum**: measured 64 / 72 / 80 / 88 / 100 at
  max 100, and 96 / 108 / 120 / 132 / 150 at max 150 — the same 0.64 / 0.72 / 0.8 / 0.88 / 1.0
  ratios. The API already returns the absolute value for that character, so read it, don't scale.
- A running sleep is a queue entry with `type: 'sleep'`, `getDuration()` **28800** (8 h, always),
  and `data = {town_name, room, townId, date_start, date_done, x, y}`. Note the coordinates live in
  `data`, **not** in `post` (`post` is only `{taskType: 'sleep'}`).
- **Sleeping while asleep the character cannot be challenged to a duel.** So a full-energy sleep is
  not waste — never cancel one unless there is actual work waiting (`hasWorkWaiting`).
- `HotelWindow.start(room)` is the global the hotel window's start button calls, using
  `HotelWindow.townid` (null until the window is opened). Wrapping that one function is how a
  manual sleep is routed into our own queue — locale-independent, and far safer than guessing the
  button out of the DOM.

### Walking (TaskWalk)

Walking to a fort, a quest giver or the county fair is a **queue entry of its own**, added through
the very same `TaskQueue.add` — so a full queue discards it exactly the way it discards a job.
Reported live: starting a walk with four jobs queued and having it vanish.

- Call sites in the bundle: `Guidepost.start_walk(id, type)` (guidepost dialog, fort battle
  notifications, the fair) and `QuestEmployerWindow.startWalk(employer)`. Note the Guidepost path
  passes **no coordinates** — the server resolves the target from `(unitId, type)`.
- `new TaskWalk(unitId, type, x, y)`. Measured on an **unqueued** instance:
  `post = {taskType:'walk', type, unitId, x, y}` (x/y simply absent when not passed),
  `getDuration()` → **0** — a walk's whole length *is* the travel — and `getIcon()` already answers
  (`.../images/jobs/walk.png`). So it rebuilds exactly from `post`, and the existing ETA chain turns
  the coordinates into the time it takes. Zero duration is correct, not a placeholder: never let the
  `DEFAULT_DURATION` fallback invent 15 minutes of standing still.
- Without coordinates the entry keeps `x: null` rather than `0`. Inventing a position would make
  every following job's ETA chain from a place the character never goes.
- **A coordinate-less walk therefore has no knowable length**, and it must not be drawn as
  `00:00:00` — that claims it is instantaneous. `durationUnknown()` makes the panel show `→?` and
  the in-game tile `?`, with a tooltip saying the times behind it are earlier than they will be.
  **Known limitation**: those following ETAs really are optimistic, and there is no client-side fix
  — the server resolves the target. If it ever matters, `Guidepost.show(id, x, y, type)` *does*
  receive the coordinates and runs before `start_walk`, so caching `(id,type) → (x,y)` there would
  cover the guidepost case (but not `start_walk(null,'fair')`, which has none anywhere).
- A walk costs **no energy and no motivation**. `jobEnergyCost` must return `0` for it explicitly —
  a `null` reads as "not known yet" and stops the whole energy chain behind it. It is also not
  "work" for the sleep question: cutting a sleep short for a walk gains nothing.

### The silent truncation in `TaskQueue.add`

Read out of the bundle, verbatim:

```js
if (taskLimit < obj.queue.length + tasks.length)
    limitedTasks = tasks.slice(0, taskLimit - obj.queue.length);
```

The sliced-off tasks are **gone**: no request, no message, no error. Our own job starts never hit
this because we hand over exactly what fits — but *every other way the game queues something* goes
straight through it. `patchTaskQueueAdd` wraps `add`, lets the game keep what fits, and diverts the
overflow into `extraJobs` instead of letting it evaporate.

- Only task types we can rebuild exactly are diverted (`DIVERTIBLE`; `walk` today). Anything else is
  left to the game's own behaviour but **logged**, rather than disappearing silently.
- `handingOver` guards our own `startJobsViaGame` batch from being diverted back into our own list.
- Everything `sanitizeJobs` needs to accept an entry back must actually be **written** by
  `saveExtraQueueToStorage`. It filters a sleep on `townId` and a walk on `walkType`, and the save
  used to omit both — which is how a queued sleep silently disappeared across a reload.

### Travel time

- `Character.calcWayTo(x, y)` → seconds, **from the character's current position only**.
- The implementation was read out of the bundle and is **exactly**:
  `GameMap.calcWayTime(from, to) = hypot(dx, dy) * Game.travelSpeed * Character.speed`.
  Both functions are **pure** — no DOM writes, no state changes, safe to call in a loop.
- So the seconds-per-unit rate is simply `Game.travelSpeed * Character.speed`; read it directly
  rather than probing (`calcWayTo(here.x + 1000, here.y) / 1000` is kept only as a fallback).
  Either way the horse and speed buffs are included — don't hardcode the constant.
- `Character.getPosition()` → `{x, y}`.
- The game folds travel **into** a queued row's displayed time (5 s travel + 15 s job → `00:00:20`).
  A separate travel row with the footprints icon exists only on the *currently running* task.

### DOM around the queue widget

```
#ui_bottomright > #ui_workcontainer > .middle > (#currentTask, #queuedTasks)
```

- `#queuedTasks` holds `<span class="task task-queuePos-N">` with `.taskTime > p`, `.taskBtns >
  (.taskHalveway, .taskAbort)`, `.icon` (background-image). Items are `inline-block` 112×67,
  wrapping 2 per row.
- The game also injects a **premium advert tile** of its own into that container
  (`getPremiumTask()`, appended when `showPremiumTask(queuePos)`) — a `span.task.hasMousePopup`
  with no text. Expect it when counting children; it is not one of ours.
- The **running** task (`#currentTask`) always carries a travel row: `.icon_taskway` +
  `.value` (title `Menetidő`), showing `00:00:00` once the character has arrived. It shows a
  **time**, never a distance — the game has no miles unit anywhere (see below).
- There is **no "mi" (miles) string in the game bundle at all** — searched the whole
  `cache/tw2game.hu_HU.js` (2.4 MB) for the token in every quoting/concatenation form, plus all
  CSS `content:` rules. Every distance the game displays is converted to a **duration** first
  (`getDistance2Town` = `calcWayTime(...).formatDuration()`), and `Number.prototype.formatDuration`
  renders `hh:mm:ss`. So a `1.000mi` on screen comes from neither the game nor this script.
- **`.middle` has a direct click handler** reacting to `taskAbort` / `taskHalveway` /
  `taskInstantFinish` / `centermap` / `icon` and parsing the queueId out of the class name.
  Injected rows reusing those classes **must** `stopImmediatePropagation()`, or clicking them
  cancels a real job. Verified: with the guard the game handler fires 0 times; an identical
  control element without it fires once.
- The game **rebuilds `#queuedTasks` when the queue changes** (not on every tick), so injected rows
  must be re-added. A `MutationObserver` does this immediately; relying on the poll made the rows
  visibly blink out and back on every completion.
- `.task`/`.icon` CSS is **scoped to `#queuedTasks`**. Rows placed in a sibling container lose all
  styling (collapse to `display:inline`, zero-height icon). They must live inside it, appended
  after the real ones so the game's index mapping is untouched.
- `#queuedTasks` is `display:none` when nothing is queued beyond the running task, and
  `#ui_workcontainer` is `display:none` when the queue is empty — injected rows are then invisible.
  This used to be an accepted limitation, but since the script stops feeding the game's queue while
  the character sleeps, "one running task and nothing behind it" became the *normal* state and the
  waiting list vanished from the widget. `setPendingHostVisible` forces `#queuedTasks` visible
  while we have rows. **`#ui_workcontainer` is deliberately left alone**: forcing that one would
  draw the game's empty queue frame.
- **Releasing that override is not the same as clearing our inline style.** The game's own hiding
  is *also* an inline `display:none` (jQuery `slideUp`), so `style.display = ''` wipes the game's
  state along with ours and leaves an empty container sitting on screen — reported live as a "small
  empty UI element" after the list emptied. Put back what the game would be holding instead: hidden
  when no real task is left in the container, `''` when one is.
- **The widget has a collapse toggle and the script has to respect it.** `#toggleTaskQueue` (the
  little arrow) swaps `#ui_workcontainer`'s class between `expanded` and `expandable`. Measured:

  | state | `#queuedTasks` inline style | `#ui_workcontainer` class |
  | --- | --- | --- |
  | expanded | *unset* | `expanded` |
  | collapsed | `display:none` | `expandable` |

  The class is the only way to tell "the game hid it because it is empty" from "the user folded it
  away". Forcing `display:block` regardless is how our rows used to reappear after the user
  deliberately collapsed the widget.
- **`#ui_workcontainer` is pinned to the bottom of the viewport and grows UPWARD without limit** —
  `max-height:none`, no clipping, `bottom:0`. Measured: 15 tiles put its top at **62 px** on a
  700 px viewport, and a few more take it negative, i.e. off the top of the screen. This is why the
  problem only showed on the *main* account: premium alone shows 9 real tiles (5 rows) before ours
  are added. `previewForSpace` therefore budgets our tiles against the room actually left above the
  widget, and `GAME_QUEUE_PREVIEW` is a **maximum**, not a fixed count.
- **`TaskQueueUi.taskCancelling` counts `$('#queuedTasks span').length`** to decide the widget is
  empty. Our injected tiles used to be `<span>`s and were counted, so the game thought a task was
  still there. Measured: `div.task` renders identically to `span.task` (112×67, same icon box), so
  our rows are `<div>`s — the separator already was one.
- The queue background is **light parchment**, so overlay text must be dark (`#4a3b28`), not cream.

### The character's status bars

`#ui_character_container` holds `.status_bar.health_bar` (`top:146px`) and `.status_bar.energy_bar`
(`top:161px`), each `137×13` at `left:3px`, `position:absolute`. The container is only 176 px tall
but `overflow:visible`, so a third bar at `top:176px` renders cleanly just below it.

Each bar is a **single div**; the fill is the sprite's horizontal offset, from `WestUi.updateEnergy`:

```js
calcWidth = (v, max, w) => Math.min(w, Math.max(0, Math.ceil(w * (v / max * 100) / 100)));
el.text(energy + ' / ' + maxEnergy)
  .css('background-position', (-137 + calcWidth(energy, maxEnergy, 137)) + 'px ' + y + 'px');
```

`y` is `-13` normally and `-26` with the `regen` premium bonus (which also adds
`.energy_premium_bonus`).

Two traps when injecting a bar of your own here, both hit in v12.4:

- **Never give it the `energy_bar` class.** The game updates via
  `$('#ui_character_container > .energy_bar')`, which matches *every* such child — so it silently
  overwrote our forecast with the real energy on each energy change. Use `status_bar` plus an own
  class and copy `background-image`/font off the real bar instead. Same reason not to copy
  `hasMousePopup` (the game adds it to our element anyway).
- **Never hardcode the vertical position.** Other userscripts add bars here too — the widely used
  *twdb* script inserts `.twdb_charcont_ext` with a `#duelmot_bar` right below the energy bar and
  grows the container to 191 px. Position below the **lowest** bar actually present, excluding your
  own element, or the two overlap (and including your own makes it walk down the screen).
- The sprite's **unfilled part is transparent**, not a drawn empty bar. The game's own bars sit
  inside the wooden frame so this never shows, but a bar hanging below the frame disappears against
  the map at low values. Give an injected bar its own dark track (`background-color` + inset
  shadow).

### Dialogs

`new west.gui.Dialog(title, msg, west.gui.Dialog.SYS_QUESTION)` → `.addButton('yes', cb)`
`.addButton('no', cb)` → `.show()`. The strings `yes`/`no`/`ok`/`cancel`/`submit`/`change` are
**keys the game localises itself** (`yes` → "Igen"); any other string is used verbatim. Icons:
`SYS_WARNING`, `SYS_USERERROR`, `SYS_OK`, `SYS_QUESTION`. A callback returning `false` keeps the
dialog open. It renders centred in the game's own style and does not block the game.

**The message is escaped** — verified live, a `<br />` shows up as literal text. Pass plain text,
or a jQuery element if markup is genuinely needed. Also watch for the ✕: a dialog closed without
pressing a button never fires a callback, so poll `getMainDiv()` for detachment if a pending flag
needs clearing.

### Map quick-start arrows

Clicking a `.jobgroup` on the map fans out individual `.job.job-{jobId}` icons in a circle; hovering
one reveals `.instantwork-short|-middle|-long` (all three exist in the CSS). This bypasses the job
window entirely.

- `.job-{id}` is a direct child of `#map` and carries **no coordinates**. The `.jobgroup` stays
  rendered underneath at the circle's centre — measured 0 px from it, next group 528 px away — so
  resolve the location by nearest group, with a distance guard.
- `#map` has a **delegated** click handler covering `.job` and `.instantwork`, so interception needs
  `stopImmediatePropagation()`.
- `JobList.getJobById(id).name` gives the display name.

### Window manager (`wman`) — the script's own panel

`wman.open(uid, title, windowclass, notanimated, noDrag, minimize_if_open)` creates a **real game
window** — frame, title bar, minimize/close buttons, dragging. The returned object has
`getContentPane()`, `appendToContentPane()`, `clearContentPane()`, `setSize`, `setMinSize/MaxSize`,
`setTitle`, `setResizeable`, `center`, `bringToTop`, `doLayout`, `saveAppearance`/`restoreAppearance`,
`destroy`. `wman.getById(uid)` retrieves it; `wman.close(uid)` closes it. `west.gui` also offers
`Scrollpane`, `Button`, `Table` etc. if native widgets are ever wanted.

Background layers, measured — these cap how tall a window can usefully be:

- `.tw2gui_window_inset` carries the **parchment field**: natural **721×420**, `no-repeat`, anchored
  bottom-left. Any window taller than ~454 px leaves the top bare.
- `.tw2gui_inner_window_bg2` is a **32×420** right-hand edge strip anchored bottom-right.

The script uses **320×210 at top-right (140 px down, 35 px in)** — deliberately short, about
4 visible rows, everything else by scrolling. Fixed chrome (title bar, status line, toolbar) eats
~134 px, so visible rows ≈ (height − 134) / 19.

**Keep the window under ~450 px and no override is needed** — the parchment covers it naturally and
the frame looks exactly like the game's. Stretching the layers to allow a taller window is possible
(`background-size: 100% 100%` on the inset, `auto 100%` on `bg2` — never both axes on `bg2`, it
smears the dark edge into a wide band) but it isn't worth it: the panel scrolls instead.

The frame has dark edge decorations on **both sides** that intrude into the content pane (the right
strip reaches ~21 px in). Inset the content (`margin: 0 20px 0 2px`) so the remove ✕ doesn't sit on
them.

**Minimizing is not a state flag, it is a hidden element.** `wman.minimize(uid)` does
`$(win.getMainDiv()).fadeOut(400)` and records the window in `wman.minimizedIds` — so a minimized
window is `display:none`, and **`bringToTop()` does nothing for it**. This shipped as a real bug in
v12.2: once the panel had been minimized, neither reopening nor the EQ menu button brought it back,
because both only called `bringToTop()`. The restore path the game itself uses is
**`wman.reopen(uid)`** — it fades the window back in *and* deletes the `minimizedIds` entry.
`wman.isMinimized(uid)` reads that map. Verified live: minimize → `display:none`, `bringToTop()` →
still `none`, `reopen()` → `block` with the content pane intact.

Note also that `wman.open(uid, …)` on an **existing** window destroys and recreates it
(`saveAppearance()` + `destroy()`), so never call it just to bring a window forward.

`wman.close(uid)` **destroys** the window — `getById` then returns nothing and reopening yields an
**empty** content pane. So the panel must be rebuilt on reopen, and there must be a way back:
a `.ui_menucontainer` + `.menulink` appended to `#ui_menubar` renders right under the gear icon.
(`#ui_scripts` exists and looks like the natural home, but the game keeps it `display:none`.)

### Cancel-all

`#cancelAllInQueue` opens a confirm dialog ("Az összes munka törlése", Igen/Nem) and only empties the
queue on confirm. Detect the **confirmation**, not the click: watch for the dialog, then after any of
its buttons is pressed poll briefly for the queue actually reaching zero. That is locale-independent
and "Nem" correctly does nothing.

## Script architecture

- **Live state, no modelling.** Queue length, limit and next-free-slot all read from `TaskQueue`.
  An earlier shadow counter drifted constantly and caused most of the early bugs.
- **Click takeover.** Job-window start buttons and map quick-start arrows are both intercepted; the
  whole batch goes to the end of `extraJobs` and the processor starts what fits. This keeps order
  FIFO — otherwise a new job would jump into a free slot ahead of jobs already waiting.
- **`processQueue`** peek → `TaskQueue.add(batch)` → splice only what was accepted. On refusal it
  backs off; after `MAX_RETRIES` a job moves to the back, after `MAX_DEFERRALS` it is dropped loudly.
- **The add *response* is the real verdict.** The synchronous queue growth only proves the game
  accepted the jobs, not the server. `startJobsViaGame` remembers the batch (`inFlightBatch`), the
  XHR interceptor pairs the response's `tasks[i]` with it — matching by jobId+duration so a
  concurrent user-initiated start can't be mistaken for ours — and puts rejected jobs back at the
  **front** of the list, in order. They are **not** dropped after a couple of tries: the most
  common cause (not enough energy) passes by itself, so it retries on a doubling backoff (20 s → 10 min, over an hour in total)
  and only gives up after `MAX_REJECTIONS`, always showing the server's own message.
- **Energy and motivation are forecast, never modelled.** `computeForecast` walks the waiting list
  in ETA order: energy comes from the game's own formula, the per-job cost and the motivation from
  the read-only job call. A job is flagged when its predicted motivation at **start** is ≤
  `MOTIVATION_WARN` (75) or when the energy makes it start later than its queue slot would — shown
  as `⚠` on the panel row, on the injected in-game tile, and summarised on the separator. When a
  value isn't known yet, nothing is guessed and nothing is flagged.
- **The energy is paid at hand-over, not at the start** (v12.15). The two moments are different and
  the difference is large: a job enters the game's queue — and is charged — as soon as a slot is
  free *and* the energy covers it, while it only *starts* once everything in front of it has
  finished. Reading the energy off the predicted start time therefore credited regeneration that
  will already have been spent. Measured live on the main account: 6 energy, two 1-hour jobs in the
  game's queue, a third 1-hour job (cost 12) waiting in ours — the panel promised "15 at the start,
  3 left", when in truth the game takes the 12 about an hour earlier and the job sets out with 0.
  So `computeForecast` walks **forward in time**, carrying `(energy, the moment it belongs to)`, and
  pays each cost at the first moment the energy reaches it. This also fixes the ceiling: the old
  model could credit a full bar and then subtract the costs from it, when the costs are in fact paid
  on the way up and the bar never fills. A real *shortfall* (negative energy) is now only possible
  with no regeneration at all, or a cost above the character's maximum; everything else is a **wait**.
- **An energy wait moves the ETAs.** The energy chain does not depend on the start times (only on
  the costs and the regen rate), but the start times depend on the energy — a job the game cannot
  yet afford starts later, and so does everything behind it. `planExtraQueue` therefore chains the
  ETAs, forecasts the energy, then pushes the ETAs out by `applyEnergyDelays`. Without it the panel
  warned "there won't be enough energy" and promised the original start time in the same breath.
  `waitMs` is measured against the *unshifted* start, so `energyDelayMs` is only the delay a job
  adds **of its own** — otherwise the ⚠ spread from the one job that waits to everything after it.
  This matters more than it sounds: a 1-hour job costs 12 energy against ~3–4.5/h of regeneration,
  so on any long list of long jobs the **energy**, not the queue, is what sets the pace.
- **When the cost is paid and what the player is shown are two different questions** (v12.16). Both
  halves of the truth have now been got wrong once: v12.14 read the energy at the start (crediting
  regeneration already spent), and v12.15 then displayed the post-deduction figure *as if frozen* —
  but energy keeps regenerating while the job waits its turn in the game's queue and while it runs.
  A row reading "0 left" at hand-over is not still 0 an hour later when the job actually ends.
  So a row shows `⚡A → B`: the level when the job **starts** and when it **finishes**. The pay
  moment moved to the tooltip, and the ⚠ / wait logic still keys on it — that is what decides
  whether the job can be handed over at all.
  This cannot be read off a single row: with the queue fed ahead, the *next* job's cost is typically
  taken while this one is still running, so a naive "start + regeneration" over-promises.
  `computeForecast` therefore records every moment energy changes hands (a job **subtracts** its
  cost, a sleep **sets** the level outright) and `makeEnergyClock` replays them in time order, which
  `attachEnergyLevels` then evaluates at the **final** start/finish times — after `applyEnergyDelays`
  has moved them. The forecast bar uses the same clock at the last job's *finish*, which is what its
  label ("a lista végén") always claimed; reading `energyAfter` there made it undershoot by roughly
  one job-length of regeneration.
- **A cost is booked when a SLOT frees, not merely when the energy covers it.** Both conditions have
  to hold, and forgetting the slot is not a rounding error: when the energy comfortably covers a
  cost, `readyFor()` returns the *carried* moment and the carried moment never advances — so every
  job's deduction was stamped on `now`, and the clock reported the whole list as already paid for
  before the first job had started. Reported live on the main account as rows reading **`100 → 100`**
  at 118 energy with a maximum of 150: 118 − 18 (the list's whole cost) = 100, and at 4.5/h
  regeneration an integer does not move within a short job, so row after row printed the same flat
  pair. **No ceiling was involved** — worth remembering, because a repeated round number looks
  exactly like a clamp and sends you hunting for one.
  Slots free in a known order, which is what `slotFreeAt(i)` walks: the ones already free, then the
  tasks in the game's queue as they finish (`gameQueueFinishes()`, `data.date_done` in
  **milliseconds**), then our own jobs. The (i+1)-th slot to free is the one job *i* goes into, and
  `i - limit < i` always, so a job can never gate on itself.
  `waitMs` deliberately measures against the **energy's** readiness only, never the slot's: waiting
  for a slot is what the queue does anyway and is already in the ETAs, so counting it there would
  push every start time out a second time.
- **A flat tail on the list is CORRECT, not a stuck value.** This was reported as a bug twice and
  chased twice; it is neither a clamp nor a broken chain. A job is handed over — and charged —
  as soon as a slot frees, i.e. `limit` jobs *before* it runs. Two consequences that look wrong and
  are not: a row's displayed start is **lower** than the same tooltip's "marad" figure (the jobs
  behind it were charged in the meantime), and the **last `limit` rows are flat**, because by then
  every cost in the list has been taken and only regeneration moves the number — 4.5/h is 0.075 per
  minute, invisible across a 15-second job. Measured live and reproduced exactly (the test under
  "REPORTED LIVE, and NOT a bug" carries the real numbers: pay chain 108→…→100, displayed
  105→…→101-flat, limit 4).
  **Do not "fix" the arithmetic here** — check against the tooltip's pay chain first.
- **The row shows the energy LEFT once the job is paid for** (`energyAfter`, the pay chain) — one
  number, stepping down by the job's own cost and back up wherever regeneration outpaces them.
  Showing the level while the job *runs* was tried in v12.16 and taken out again: it is truthful,
  but because the game is fed `limit` jobs ahead it goes flat for the last `limit` rows of every
  list, i.e. exactly where a long list gets interesting. It survives in the tooltip. This was
  settled by the user after seeing both against real data — don't re-litigate it without new
  evidence.
- **Past the first unknown cost the chain is blind.** `computeForecast` deliberately does not advance
  when `costOf` returns null, so the clock books nothing further and returns the *same* level for
  every remaining row — a confident-looking flat pair that is only the last thing we knew. v12.15
  rendered nothing in that case and that was right; `chainBroken` marks the row and everything behind
  it, and `attachEnergyLevels` stops there.
  **Known simplification:** motivation regeneration is not modelled (it was not measured; it is
  believed to reset daily, time of day unknown). This needs no correction for *current* values —
  the motivation is re-read from the server every `JOB_INFO_TTL` (5 min), so a reset is picked up
  by itself; only the projection across a queue that spans the reset stays pessimistic, which is
  the safe direction. Measuring the reset would take a day-long observation.
- **A sleep in the *game's* queue must seed the forecast.** Energy is otherwise extrapolated from
  the current regen rate, which across an 8-hour sleep is badly wrong: measured live on a main
  account, 8 energy was projected to 48 instead of 150, because the awake rate (5/h) was dragged
  across the whole sleep. `initialEnergyCarry` seeds the chain with the room's fill-up level.
  The equivalent case for a sleep in *our* list was already handled.
- **Do not estimate a not-yet-started sleep with the awake regen rate.** The game raises
  `energyRegen` only once the character has actually arrived and started sleeping
  (`task.isArrived(serverTime)` — `queuePos === 0` is not enough, the character may still be
  travelling). With the awake rate, filling to max looks like ~28 h, so the 8-hour cap never binds
  and every following job's ETA slips by eight hours. Use the measured sleeping rate until it
  really starts, then the live value.
- **The energy pre-check** in `processQueue` refuses to hand over a job the character can't afford
  and waits exactly as long as the regen needs, instead of letting the server reject it. This is the
  proper fix for "energy ran out"; the rejection recovery above is the safety net behind it.
- **Sleeping** is an ordinary entry in `extraJobs` (`taskType: 'sleep'` with `townId`/`room`), so it
  inherits FIFO, storage and rendering. Three rules earned their place:
  it is **sent alone** (jobs queued behind it would have their energy deducted immediately — exactly
  the energy the sleep is meant to build); **nothing is fed into the queue while sleeping**, for the
  same reason; and only a **free** room is ever chosen automatically, never one that costs the
  user's money. It is offered, never inserted unasked, and `cancelSleepIfFull` ends it via
  `TaskQueue.cancel(queuePos)` once energy reaches the sleep's **goal**.
- **A declined offer is silenced, not deleted** (v12.14). Saying "no" used to null `sleepOffer` and
  go quiet for `SLEEP_DECLINE_MS` (30 min), which left the hotel window as the only way back to a
  sleep — the user had to leave the panel to change their mind. Now the decline sets
  `sleepOffer.declined` and the row stays in the panel, **collapsed to a single `Alvás…` button**
  (`.lisa-offer-quiet`, a muted version of the same row); `reopenSleepOffer` expands it back to the
  three choices and clears the quiet window. `sleepDeclinedUntil` now gates **only the game's
  dialog**, so an offer raised inside that window is born collapsed — row yes, modal no.
  Two rules keep the row honest, both driven by `offerSleepIfForecastRunsOut` every second:
  `maybeOfferSleep` **refreshes an existing offer's numbers** instead of returning early (the list
  moves under it, and a stale "3 energy needed" is worse than none), and
  `clearDeclinedSleepOffer` drops it once the shortage is gone or a sleep is queued/running.
  A **pending** offer is deliberately never auto-cleared: its dialog is on screen being answered.
- **How long to sleep is a per-sleep decision**, `sleepMode`: `'full'` fills to the room's level,
  `'enough'` stops as soon as the jobs *behind* that sleep are covered (`energyNeededFrom`, summed
  to the next sleep, ignoring regeneration during those jobs — deliberately conservative). The
  goal is recomputed **live**, so queueing more jobs mid-sleep raises it by itself; it feeds the
  cancel check, the ETA clamp, the forecast carry and the displayed sleep duration alike, which is
  why a sleep entry's length is computed by `jobDurationSeconds` rather than read off the stored
  `duration`. Unknown job costs fall back to `'full'` — never guess and wake up short.
  For a sleep already running, the choice is asked once per `queueId` and persisted
  (`STORAGE_SLEEP_MODE`), so a reload doesn't re-ask; a sleep the script started carries the
  decision over via `pendingSleepMode`. **Dismissing either dialog means `'full'`** — the safe
  default, since a sleeping character cannot be duelled.
  **Only an explicitly chosen mode carries over** (`modeChosen`). A sleep started by hand in the
  hotel gets `'full'` merely as a *default*, and treating that as a decision is what made the
  script stop asking entirely: the defaulted mode was adopted by the next, unrelated sleep, which
  then silently ran full-length. For the same reason `adoptPendingSleepMode` binds a pending mode
  to its queue entry on the very next tick, **before** the "is there work waiting" check — an
  unbound mode must never survive long enough to be picked up by a different sleep.
  `queueTailAnchor` also clamps a running sleep's 8-hour `date_done` to the predicted wake-up,
  otherwise every following ETA would be pushed eight hours out.
  **No work waiting ⇒ no question and no wake-up.** Uninterrupted sleep is the default; the
  running-sleep dialog is only raised once real work exists, and if that work is later removed
  `'enough'` falls back to the room's level by itself (`sleepGoalEnergy` returns the room target
  when the need is `0`, not just when it is unknown). "Real work" means a non-sleep entry in
  `extraJobs`, or a game-queue entry whose `post` carries a numeric `jobId` — v12.10 tightened
  `hasWorkWaiting` from "anything that isn't a sleep", which let a non-job queue entry raise the
  dialog with "0 munka vár a sorban". `countWorkWaiting` is the same predicate with a count, so
  the dialog's number covers both sources (the old text printed `extraJobs.length` alone).
  **Only work *behind* the sleep counts** (v12.13). `hasWorkWaiting(sleepTask)`/
  `countWorkWaiting(sleepTask)` ignore game-queue entries at an index at or before the sleep's.
  A sleep is sent alone, but the jobs started *before* it are still running in the game's queue
  ahead of it — they finish before the sleep even starts, so waking early does nothing for them.
  Counting them is what raised "meddig aludjak?" for a sleep queued last with nothing after it.
  The dialog also no longer claims the character is asleep when the sleep is still queued
  (`queuePos !== 0`).
- **Keep-awake** (`updateKeepAwake`, only while jobs are waiting): a Screen Wake Lock against the
  display/machine sleeping — re-requested on `visibilitychange` and `focus`, since the browser
  releases it when the tab is hidden — plus an inaudible looping WAV, because Chrome does not freeze
  a tab that is playing audio. A fully silent track would not count as playing, hence amplitude ±1.
  Autoplay is blocked until a user gesture, so playback is retried on `click`/`pointerdown`/
  `keydown`/`touchstart`. Neither mechanism replaces the OS/browser settings (`caffeinate`, Chrome
  Memory Saver exclusion — Memory Saver *discards* the tab, which no wake lock or audio survives).

  **A media element created while the tab is hidden never loads** (measured, Chrome): `readyState`
  stays 0, `networkState` stays LOADING, and the `play()` promise never settles. Not a URI problem —
  `blob:` and `data:` behave identically. The same element created while *visible* keeps playing
  happily after the tab is hidden (measured: 7 minutes, 4 `timeupdate`/s). So `ensureKeepAudioElement`
  runs at **boot** and again on every `visibilitychange` → visible, rather than lazily at the first
  queued job — otherwise the most common case of all ("queue a long list, then put the browser away")
  is exactly the one left unprotected. Note `document.visibilityState` is `hidden` for an **occluded
  or minimized window**, not just a background tab, so this is easy to hit.

  **Do not detect a stalled loop by comparing `currentTime` between ticks.** The loop is exactly 1 s
  and the tick is ~1 s, so the sampling aliases onto the same phase and reports a false stall — v12.12
  shipped this and cried "hang: elakadt" in both Chrome and Safari while playback was fine. Use time
  since the last `timeupdate` (phase-independent), plus an explicit `readyState === 0` check for the
  never-loaded case above, which is the one condition `paused === false` hides.
- **The ticker (`startTicker`/`tick`) is what makes a background tab usable.** Measured on the live
  game page, Chrome, two 7-minute runs with the tab hidden — worst gap between ticks:

  | source | visible tab | hidden tab |
  | --- | --- | --- |
  | `setInterval(1000)` | 1.0 s | **60.0 s** |
  | `setTimeout` chain | 1.0 s | **60.0 s** |
  | Web Worker `setInterval(1000)` | 1.0 s | **1.0 s** |
  | `<audio>` `timeupdate` | — | **0.27 s** |

  Two facts worth keeping. First, the tab's own timers collapse to once a minute
  ("intensive throttling") — so a freed slot could sit empty for a minute. Second, **the quiet loop
  does not help with this**: the second run was measured with the audio provably playing
  (`paused:false`, `currentTime` advancing) and `setInterval` still woke only 7 times in 440 s. The
  audio defends against *freezing*, the worker against *throttling*; they are separate problems and
  both are needed. Neither run froze the tab within 7 minutes.

  Hence three tick sources, all calling the same `tick()`, which de-duplicates on
  `WATCH_INTERVAL * 0.6` so they can never double up: the Web Worker (primary), the keep-awake
  audio's `timeupdate` (only while jobs wait, and the fallback if a CSP ever blocks `blob:` workers
  — **verified live that the-west.hu allows them**), and the tab's own `setInterval` (last resort).
  `tick` also drives `refreshLeadership`; leaving that on its own `setInterval` meant a throttled
  leader let its own 15 s TTL lapse, and two hidden tabs would take the lead from each other.
- **`pumpNextJobTimer`** fires the deadline as soon as a tick observes it has passed, instead of
  waiting for the next `TIMER_CHUNK`. Same absolute deadline — it never starts anything early.
- **`pumpGameClient` is what actually makes a background tab work.** Ticking our own code faster
  was necessary but nowhere near sufficient: **the game's client is the thing that falls behind.**
  Read out of the bundle:

  ```js
  obj.init = function(){ … window.setInterval(obj.tick, 1000); };      // TaskQueueUi
  obj.tick = function(){
      if (!TaskQueue.queue[0] || !TaskQueue.queue[0].queueId) return TaskQueue.timeleft = 0;
      var task = TaskQueue.getByQueuePos(0); …
      if (taskDur <= 0) { EventHandler.signal('task-finish-'+task.type, [task.data]);
                          TaskQueue.finish(task); return; }   // ← ONE task, then returns
      … };
  ```

  So retiring a finished task is driven by a **main-thread `setInterval`** — throttled to once a
  minute in a hidden tab — and it retires **at most one task per call**. `Character.tick4Character`
  is the same story on a 2 s `Ticker`, so `Character.energy` goes stale too.

  The consequence is not cosmetic. `TaskQueue.queue` stays at its pre-freeze length, so `freeSlots()`
  reads 0 — and even computing free slots ourselves would not help, because **`TaskQueue.add` gates
  on its own stale `queue.length`** (`taskLimit < obj.queue.length + tasks.length` → silently
  truncates). Nothing can be started until the game's own client catches up.

  Measured live, one hidden tab already in intensive throttling, 4 × 15 s jobs, the only variable
  being whether we call the game's tick:

  | | control (no pump) | with `pumpGameClient` |
  | --- | --- | --- |
  | queue drained at | 384, 444, 504, 564 s | 23, 38, 53, 68 s |
  | spacing | **60 s** (the throttle period) | **15 s** (the real job length) |
  | total to drain | **234 s** | **63 s** |
  | client lag behind server | up to **174 s** | ~3 s |

  The server had finished all four by ~390 s in both arms — it never cared about the tab. This is
  also exactly what the user saw *before* the script existed: come back to the tab and four jobs
  "count down to zero" and vanish one per second, because the tick resumes at 1 Hz and works off the
  backlog one task per call.

  So `tick` calls `TaskQueueUi.tick()` in a loop while the queue keeps shrinking (bounded by
  `gameQueueLimit() + 1`), plus `Character.tick4Character()` once. **These are the game's own
  functions at the rate the game already intends** — we are restoring the normal 1 Hz, not
  exceeding it. Skipped while `TaskQueue.busy` or our own `processing` is set, so we never splice
  the queue under an in-flight batch. `lisaDiag().gamePump` reports whether it is available.

  **End-to-end result** (v12.12, measured through the script's own interception path — 30 × 15 s
  jobs started from the job window, tab hidden for the entire 10-minute run, well past the 5-minute
  intensive-throttling threshold): 25 feeds, gaps **min 14 s / max 16 s / mean 15.0 s**, each slot
  refilled within ~1 s of freeing. That is **4.0 jobs/minute — the theoretical maximum** for 15 s
  jobs, sustained in a hidden tab, against the ~0.45/min the user measured before the fix.
- **After a gap ≥ `LONG_GAP_MS`, if the pump is unavailable, the game client is stale.** `tick`
  then pushes the next decision out by `LONG_GAP_SETTLE_MS` to let the game catch up on its own.
  With the pump working this branch never runs — it is the fallback for a client without
  `TaskQueueUi`.
- **Diagnostics**: `window.lisaDiag()` in the console, and the same summary as the tooltip on the
  panel's status line. Worst hidden-tab gap is the number that matters — if it is ~1 s the ticker is
  doing its job, if it is ~60 s the worker never started.
- **In-game rows are re-injected by a `MutationObserver`** on `#queuedTasks`, not just by the timer.
  The game rebuilds that container on every queue change and drops our rows with it; waiting for the
  poll made them visibly blink out and back. The observer only re-renders when our separator is
  *absent*, so our own writes don't loop.
- **`ensureProcessing(pullInMs)`** deliberately does nothing when a timer is already armed —
  otherwise the 5-second leadership heartbeat would trample every intentional wait (full queue,
  rejection backoff). But *new* work must pass `pullInMs` to pull the deadline in, or a job added
  during a ten-minute backoff sits idle until that backoff expires. Live symptom: a sleep queued
  by hand "did nothing" and only a page reload started it. Every user-facing add path passes
  `CONFIG.NEW_WORK_DELAY`; the heartbeat and boot deliberately do not.
- **`watchGameQueue`** every 1 s: refreshes the badge and ETAs, re-injects in-game rows, and on a
  **decrease** in queue length starts the next job within 0.4 s. Keying on the decrease (not on
  "free slots exist") is deliberate — otherwise a refusal would retry every 2 s forever.
- **Leader lock** in `localStorage`: only one tab processes. A **visible** tab always takes over from
  a background one, leadership is released on `pagehide`. Without the visibility rule a forgotten
  background tab silently paralyses the tab the user is looking at.
- **Storage** is versioned in the *content*, not the key, with one-time migration from the old keys.
  Never version the key — that orphans the user's saved queue on every release.
- `jobHistory` has no UI any more (the Előzmények tab was removed once starting was wired into the
  game's own UI). It is kept only as a duration fallback in `parseJobWindow`.

## Conventions

- **Everything in the code is English except what the user actually sees in the game.** Comments,
  identifiers, `console.*` messages and the test assertion labels are English. Hungarian is reserved
  for the in-game UI: panel texts and tooltips, `west.gui` dialogs, `updateUIStatus` lines, the
  injected queue rows and the `@description` header. `lisaDiag()`'s keys and values are English, with
  one deliberate exception — `keepAwake` carries `keepAwakeStatus()`, which is also rendered as the
  panel status line's tooltip, so it (and `tickHealthText()`) stays Hungarian.
  **The test is "does the player read this in the game?"** If not, it is English — that includes
  commit messages, this file, and anything else outside the running UI. The code was translated
  wholesale after v12.13, and the history was rewritten to English in the same session; nothing
  Hungarian should reappear outside the in-game strings listed above.
- Comments explain *why*, especially where a subtle game behaviour forced the design. Keep them.
- Bump `@name`, `@version` and the boot `console.log` together on every release — and the release
  number plus the assertion count at the top of this file.
- Run `node smoke-load.js && node test-queue.js` before committing. Add cases for anything measured in-game so it does not
  have to be rediscovered.
- The test harness pulls functions out of the userscript **by name** (`extract('foo')`), so renaming
  a function breaks the tests, and a new call to a browser-only function inside an already-extracted
  one needs a stub near the top of `test-queue.js`. That is the usual cause of a sudden
  `ReferenceError: … is not defined` when the tests had been passing.
