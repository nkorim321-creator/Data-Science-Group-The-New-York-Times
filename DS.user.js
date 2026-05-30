// ==UserScript==
// @name         MTurk Automation - NYT (BST Time-Window Reload & Fast Return)
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  Automates NYT HITs on MTurk: BST time-windowed queue reload (every 1 min during specific windows), opens detected NYT HITs in NEW background tabs (queue tab stays put), random checkbox select + submit in the new tab, reliably closes the HIT tab after submit via path-keyed cross-tab handle (no about:blank), closes any duplicate /tasks tab after a 15 s grace period, blank-page recovery.
// @author       You
// @match        https://worker.mturk.com/*
// @match        https://*.mturkcontent.com/*
// @match        https://*.s3.amazonaws.com/*
// @grant        GM_closeBrowserTab
// @grant        GM_openInTab
// @updateURL    https://raw.githubusercontent.com/nkorim321-creator/Data-Science-Group-The-New-York-Times/main/DS.user.js
// @downloadURL  https://raw.githubusercontent.com/nkorim321-creator/Data-Science-Group-The-New-York-Times/main/DS.user.js
// ==/UserScript==

(function() {
    'use strict';

    const TARGET_REQUESTER = "Data Science Group, The New York Times";
    const QUEUE_URL = "https://worker.mturk.com/tasks";
    const currentUrl = window.location.href;

    // Cross-tab close coordination.
    //
    // GM_openInTab uses the extension API (chrome.tabs.create) to open
    // tabs. Chrome treats those tabs as "extension-opened" rather than
    // "script-opened", so window.close() called from inside the tab is
    // blocked - and Violentmonkey doesn't expose GM_closeBrowserTab,
    // so the script inside the HIT tab has NO way to close itself.
    //
    // What DOES work: the value GM_openInTab returns has a .close()
    // method that runs chrome.tabs.remove on the OPENER (queue tab)
    // side. So the queue tab keeps a list of { key, handle } for every
    // HIT tab it opens. When a HIT tab finishes submitting, it
    // broadcasts its key on a BroadcastChannel; the queue tab matches
    // the key to a handle and calls handle.close().
    //
    // The key is the HIT's own /projects/<projectId>/tasks/<taskId>
    // path, read from window.location (NOT a URL fragment - MTurk's
    // SPA router strips hashes before our script can read them, which
    // is why the old fragment approach failed and left about:blank
    // tabs behind). The path is the route itself, so it always
    // survives, and it's stored in sessionStorage so it persists
    // across MTurk's post-submit navigation within the same tab.
    const CLOSE_CHANNEL_NAME = '__nyt_tab_close__';
    const HIT_KEY_SESSION_KEY = '__nyt_hit_key__';

    // Extract a stable per-HIT key from a URL or path:
    // "/projects/<projectId>/tasks/<taskId>" -> "<projectId>/<taskId>".
    // Returns null if the URL isn't a HIT task URL.
    const extractHitKey = (urlOrPath) => {
        try {
            let path = urlOrPath;
            if (/^https?:/i.test(urlOrPath)) path = new URL(urlOrPath).pathname;
            const m = path.match(/\/projects\/([^/]+)\/tasks\/([^/?#]+)/);
            if (m) return m[1] + '/' + m[2];
        } catch (e) {}
        return null;
    };

    // Open a URL in a new background tab. Uses GM_openInTab when
    // available (Tampermonkey/Violentmonkey - bypasses popup blocker
    // even without a user gesture, which matters because we open from
    // a MutationObserver callback). Falls back to window.open.
    //
    // The returned handle is registered with the caller-supplied
    // onHandle callback so the caller can save it for later closing.
    const openTabInBackground = (url, onHandle) => {
        try {
            if (typeof GM_openInTab === 'function') {
                const handle = GM_openInTab(url, { active: false, insert: true, setParent: true });
                if (handle && onHandle) onHandle(handle);
                return;
            }
        } catch (e) {}
        try { window.open(url, '_blank'); } catch (e) {}
    };

    // Close the current tab. Two independent mechanisms run; whichever
    // applies to this tab's origin wins. NO about:blank fallback - a
    // visible blank tab is worse than a tab that closes a moment later
    // via its opener, and with the path-based key the broadcast is now
    // reliable.
    //   A. Cross-tab broadcast - for tabs WE opened with GM_openInTab.
    //      The HIT tab can't close itself (extension-opened), so it
    //      asks the queue tab (which holds the handle) to close it.
    //   B. Local close paths    - for tabs opened by window.open (e.g.
    //      a HIT the worker grabbed via PCM). Those ARE script-opened,
    //      so window.close() / GM_closeBrowserTab work directly.
    const closeThisTabNow = () => {
        // A. Broadcast our path key so the queue tab can close us.
        try {
            const myKey = sessionStorage.getItem(HIT_KEY_SESSION_KEY) ||
                          extractHitKey(window.location.href);
            const ch = new BroadcastChannel(CLOSE_CHANNEL_NAME);
            ch.postMessage({ type: 'close-tab', key: myKey || null });
        } catch (e) {}
        // B. Local close paths (work for window.open / PCM tabs and for
        //    Tampermonkey via GM_closeBrowserTab).
        try {
            if (typeof GM_closeBrowserTab !== 'undefined') {
                GM_closeBrowserTab();
            }
        } catch (e) {}
        try { window.opener = null; } catch (e) {}
        try { window.open('', '_self'); } catch (e) {}
        try { window.close(); } catch (e) {}
        try { window.top.close(); } catch (e) {}
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow.close) {
                unsafeWindow.close();
            }
        } catch (e) {}
    };

    // ---------------------------------------------------------
    // Bangladesh Standard Time (BST = UTC+6) reload windows.
    // Page reloads every 60s ONLY when current BST time is inside
    // one of these 30-minute windows. Outside windows = idle.
    //   02:00 - 02:30 AM
    //   04:00 - 04:30 PM  (16:00 - 16:30)
    //   06:00 - 06:30 AM
    //   11:00 - 11:30 AM
    //   09:00 - 09:30 PM  (21:00 - 21:30)
    // ---------------------------------------------------------
    const RELOAD_WINDOWS = [
        [ 2 * 60,  2 * 60 + 30],
        [16 * 60, 16 * 60 + 30],
        [ 6 * 60,  6 * 60 + 30],
        [11 * 60, 11 * 60 + 30],
        [21 * 60, 21 * 60 + 30]
    ];

    const getBSTMinutesOfDay = () => {
        const now = new Date();
        const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
        return (utcMins + 6 * 60) % (24 * 60);
    };

    const isInReloadWindow = () => {
        const m = getBSTMinutesOfDay();
        return RELOAD_WINDOWS.some(([s, e]) => m >= s && m < e);
    };

    // ---------------------------------------------------------
    // URL dispatch: identify which kind of page we're on.
    //   Queue page:        worker.mturk.com/tasks
    //   HIT shell/iframe:  worker.mturk.com/projects/<id>/tasks/<id>
    //                      *.mturkcontent.com / *.s3.amazonaws.com
    //   Other mturk page:  worker.mturk.com/* (root, /projects listing,
    //                      /dashboard, etc.) - used for post-submit redirect
    // ---------------------------------------------------------
    let hostname = '';
    let pathname = '';
    try {
        const u = new URL(currentUrl);
        hostname = u.hostname;
        pathname = u.pathname;
    } catch (e) {
        // fallback
    }

    const isMturkIframe = /mturkcontent\.com$/.test(hostname) || /\.s3\.amazonaws\.com$/.test(hostname);
    const isWorkerMturk = hostname === 'worker.mturk.com';
    const isQueuePage = isWorkerMturk && pathname === '/tasks';
    const isHitPage = isMturkIframe ||
                      (isWorkerMturk && /^\/projects\/[^/]+\/tasks\//.test(pathname));
    const isOtherMturkPage = isWorkerMturk && !isQueuePage && !isHitPage;

    // ---------------------------------------------------------
    // PHASE 0: Any non-queue worker.mturk.com page - when a
    // "HIT Submitted" / "successfully submitted" banner appears,
    // close this tab instantly. The always-open queue tab stays
    // on /tasks and never reaches this code path; only HIT tabs
    // (auto-opened by Phase 1 OR opened manually via PCM /
    // middle-click) end up here, and the worker wants both kinds
    // closed after submit.
    // ---------------------------------------------------------
    if (isOtherMturkPage) {
        const SUBMIT_MARKERS = ['HIT Submitted', 'successfully submitted', 'has been successfully'];
        let done = false;

        const checkForSubmitBanner = () => {
            if (done || !document.body) return false;
            const text = document.body.textContent || '';
            for (const marker of SUBMIT_MARKERS) {
                if (text.includes(marker)) {
                    done = true;
                    closeThisTabNow();
                    return true;
                }
            }
            return false;
        };

        const startSubmitWatcher = () => {
            if (!document.body) {
                setTimeout(startSubmitWatcher, 50);
                return;
            }
            if (checkForSubmitBanner()) return;
            const obs = new MutationObserver(() => {
                if (checkForSubmitBanner()) obs.disconnect();
            });
            obs.observe(document.body, { childList: true, subtree: true });
            // Stop watching after 15 s - if no banner by then, the
            // worker just navigated here normally (browse, dashboard,
            // etc.), so leave the page alone.
            setTimeout(() => obs.disconnect(), 15000);
        };
        startSubmitWatcher();
    }

    // ---------------------------------------------------------
    // PHASE 1: Queue page - scan for requester + time-windowed reload
    // ---------------------------------------------------------
    if (isQueuePage) {

        // ---------------------------------------------------------
        // Single-instance: if another /tasks tab is already open,
        // close THIS one instantly. The first tab to load claims
        // a localStorage slot and refreshes it every 1.5 s; any
        // /tasks tab that loads later and sees a fresh claim from
        // a different tabId closes itself with no warning page.
        //
        // The tabId is persisted in sessionStorage so that when the
        // *same* tab reloads (which it does every 60 s during a BST
        // window), the new script instance recognises its own
        // previous heartbeat and does NOT treat itself as a duplicate.
        // Without this, the 60-s reload loop would silently destroy
        // itself on every tick.
        // ---------------------------------------------------------
        const PRIMARY_KEY = '__nyt_tasks_primary__';
        const TAB_ID_KEY = '__nyt_tasks_tab_id__';
        const STALE_MS = 5000;
        const HEARTBEAT_MS = 1500;

        const DUPLICATE_WAIT_MS = 15000;

        let myTabId;
        try {
            myTabId = sessionStorage.getItem(TAB_ID_KEY);
            if (!myTabId) {
                myTabId = Date.now() + '-' + Math.random().toString(36).slice(2, 11);
                sessionStorage.setItem(TAB_ID_KEY, myTabId);
            }
        } catch (e) {
            myTabId = Date.now() + '-' + Math.random().toString(36).slice(2, 11);
        }

        const readPrimary = () => {
            try {
                const data = JSON.parse(localStorage.getItem(PRIMARY_KEY) || 'null');
                if (data && Date.now() - data.heartbeat < STALE_MS) return data;
            } catch (e) {}
            return null;
        };
        const writePrimary = () => {
            try {
                localStorage.setItem(PRIMARY_KEY, JSON.stringify({
                    tabId: myTabId, heartbeat: Date.now()
                }));
            } catch (e) {}
        };

        // Shared with both onUnload and runQueueMain via closure.
        // Lives outside runQueueMain so the unload handler can close
        // every open HIT tab even though the handles are populated
        // from inside runQueueMain.
        let openedTabHandles = [];

        // Runs on every unload (reload, navigate-away, close). Releases
        // our primary slot and closes every HIT tab we opened so they
        // don't outlive their opener and turn into orphans.
        const onUnload = () => {
            try {
                const data = JSON.parse(localStorage.getItem(PRIMARY_KEY) || 'null');
                if (data && data.tabId === myTabId) localStorage.removeItem(PRIMARY_KEY);
            } catch (e) {}
            try {
                for (const entry of openedTabHandles) {
                    try {
                        if (entry.handle && typeof entry.handle.close === 'function') {
                            entry.handle.close();
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        };

        // The scanner, reload tick, blank recovery, etc. live inside
        // this function so they only ever start running once this tab
        // has confirmed it's the sole primary - a duplicate that's
        // about to close shouldn't be opening HIT tabs in parallel.
        const runQueueMain = () => {
            const PAGE_LOAD_TIME = Date.now();
            const RELOAD_INTERVAL_MS = 60 * 1000;
            // Track HIT URLs we've already opened during this page
            // session so we don't keep re-opening the same one as the
            // queue re-scans. Resets on every page reload, which is
            // fine because by then any accepted HIT is no longer in
            // the queue.
            const openedHits = new Set();

            const closeHandleEntry = (entry) => {
                if (!entry) return;
                if (entry.handle && typeof entry.handle.close === 'function') {
                    try { entry.handle.close(); } catch (e) {}
                }
                openedTabHandles = openedTabHandles.filter((e) => e !== entry);
            };

            // Listen for close requests from HIT tabs we opened.
            try {
                const closeChannel = new BroadcastChannel(CLOSE_CHANNEL_NAME);
                const projectOf = (k) => (k ? String(k).split('/')[0] : null);
                closeChannel.onmessage = (event) => {
                    if (!event.data || event.data.type !== 'close-tab') return;
                    const key = event.data.key;
                    // 1. Exact key match - precise, never closes the wrong tab.
                    let entry = key ? openedTabHandles.find((e) => e.key === key) : null;
                    // 2. Same-project fallback: covers accept_random -> real
                    //    assignmentId, where the projectId is stable but the
                    //    task segment changes. Restricted to the same project
                    //    so an unrelated tab (e.g. a different requester's
                    //    HIT submitted via PCM) can NEVER close one of ours.
                    if (!entry && key) {
                        const proj = projectOf(key);
                        const matches = openedTabHandles.filter((e) => projectOf(e.key) === proj);
                        if (matches.length === 1) entry = matches[0];
                    }
                    closeHandleEntry(entry);
                };
            } catch (e) {}

            // Periodically evict stale handles (HIT never submitted,
            // tab closed by hand, etc.) so a stuck tab can't keep the
            // queue tab from reloading forever. 45 s is well past any
            // NYT HIT's auto-submit time.
            setInterval(() => {
                const cutoff = Date.now() - 45 * 1000;
                for (const entry of openedTabHandles.slice()) {
                    if (entry.openedAt < cutoff) closeHandleEntry(entry);
                }
            }, 5 * 1000);

            const scanQueueForRequester = () => {
                const rows = document.querySelectorAll(
                    '.project-detail-bar, .table-row, tr, li.task-row, ' +
                    'div[class*="task-row"], div[class*="project-detail"]'
                );

                for (const row of rows) {
                    if (!row.textContent || !row.textContent.includes(TARGET_REQUESTER)) continue;

                    const workButton = row.querySelector(
                        'a[href*="/projects/"][href*="/tasks/accept"], ' +
                        'a.btn[href*="/projects/"], ' +
                        'a[class*="work"][href*="/projects/"]'
                    );

                    if (!workButton) continue;

                    const rawHref = workButton.getAttribute('href') || workButton.href;
                    if (!rawHref) continue;
                    let absoluteUrl;
                    try {
                        absoluteUrl = new URL(rawHref, window.location.origin).href;
                    } catch (e) {
                        continue;
                    }
                    if (openedHits.has(absoluteUrl)) continue;
                    openedHits.add(absoluteUrl);

                    // Key this tab by its HIT path so it can match itself
                    // when it broadcasts a close request later.
                    const key = extractHitKey(absoluteUrl);

                    openTabInBackground(absoluteUrl, (handle) => {
                        const entry = { key, handle, openedAt: Date.now() };
                        openedTabHandles.push(entry);
                        try {
                            if ('onclose' in handle) {
                                handle.onclose = () => {
                                    openedTabHandles = openedTabHandles.filter((e) => e !== entry);
                                };
                            }
                        } catch (e) {}
                    });
                }
            };

            // Observer keeps running for the lifetime of this /tasks
            // page - every time the queue updates we re-scan and open
            // any new NYT HITs in fresh background tabs. The queue tab
            // itself never navigates away.
            const queueObserver = new MutationObserver(scanQueueForRequester);

            const startScanning = () => {
                if (!document.body) {
                    setTimeout(startScanning, 50);
                    return;
                }
                queueObserver.observe(document.body, { childList: true, subtree: true });
                scanQueueForRequester();
            };
            startScanning();

            // Reload loop: ticks every 1 s. Reload only when (a) inside
            // a BST window AND (b) 60 s elapsed since load AND (c) we
            // have no HIT tabs in flight. Reloading would destroy the
            // in-memory handle list and orphan any open HIT tab, so we
            // hold off until they've all closed. (The 45 s stale-
            // evictor guarantees this can't stall the reload forever.)
            const reloadTick = () => {
                if (!isInReloadWindow()) return;
                if (Date.now() - PAGE_LOAD_TIME < RELOAD_INTERVAL_MS) return;
                if (openedTabHandles.length > 0) return;
                window.location.reload();
            };
            setInterval(reloadTick, 1000);

            // Backup: when tab becomes visible after being hidden,
            // re-check immediately (handles background-tab setTimeout/
            // setInterval throttling).
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) reloadTick();
            });

            // ---------------------------------------------------------
            // Blank-page recovery: MTurk sometimes renders /tasks as a
            // completely blank white page on certain Worker IDs. Check
            // 4 s after load, and re-check every 15 s thereafter, in
            // case the page goes blank later. Reload aggressively
            // (up to MAX_BLANK_RELOADS times) until the page renders
            // properly. Counter resets the moment the page loads OK.
            // ---------------------------------------------------------
            const BLANK_CHECK_DELAY_MS = 4000;
            const BLANK_RECHECK_MS = 15000;
            const MAX_BLANK_RELOADS = 100;
            const BLANK_RELOAD_KEY = '__nyt_userscript_blank_count__';

            const pageLooksLoaded = () => {
                const text = document.body ? document.body.textContent : '';
                if (text.length < 200) return false;
                return text.includes('HITs Queue') ||
                       text.includes('Your HITs') ||
                       text.includes('Requester') ||
                       text.includes('Browse all available HITs') ||
                       text.includes('Sign Out');
            };

            const recoverFromBlank = () => {
                if (pageLooksLoaded()) {
                    sessionStorage.removeItem(BLANK_RELOAD_KEY);
                    return;
                }
                const count = parseInt(sessionStorage.getItem(BLANK_RELOAD_KEY) || '0', 10);
                if (count >= MAX_BLANK_RELOADS) return;
                sessionStorage.setItem(BLANK_RELOAD_KEY, (count + 1).toString());
                if (count < 2) {
                    window.location.reload();
                } else {
                    window.location.href = QUEUE_URL + '?_t=' + Date.now();
                }
            };

            setTimeout(recoverFromBlank, BLANK_CHECK_DELAY_MS);
            // Keep checking every 15 s in case the page renders fine
            // at first but goes blank later (rare but reported).
            setInterval(recoverFromBlank, BLANK_RECHECK_MS);
        };

        // Become the primary /tasks tab: claim the slot, start the
        // heartbeat, register the unload cleanup, and run the rest of
        // Phase 1 (scanner / reload tick / blank recovery).
        const becomePrimary = () => {
            writePrimary();
            setInterval(() => {
                const current = readPrimary();
                if (current && current.tabId !== myTabId) {
                    closeThisTabNow();
                    return;
                }
                writePrimary();
            }, HEARTBEAT_MS);

            window.addEventListener('beforeunload', onUnload);
            runQueueMain();
        };

        const existing = readPrimary();
        if (existing && existing.tabId !== myTabId) {
            // Another /tasks tab is already primary. Wait 15 s before
            // closing this one - the wait gives transient overlaps
            // (e.g. the primary reloading mid-tick) time to settle.
            // If the primary's heartbeat goes stale during the wait,
            // this tab promotes itself instead of closing.
            setTimeout(() => {
                const stillExisting = readPrimary();
                if (stillExisting && stillExisting.tabId !== myTabId) {
                    closeThisTabNow();
                } else {
                    becomePrimary();
                }
            }, DUPLICATE_WAIT_MS);
        } else {
            becomePrimary();
        }
    }

    // ---------------------------------------------------------
    // PHASE 2: HIT page - auto-select checkbox, submit. After the
    // submit, MTurk navigates the top window to /projects (or /)
    // with a "HIT Submitted" banner, where Phase 0 closes the tab.
    //
    // The script runs in BOTH the worker.mturk.com top window AND
    // the cross-origin mturkcontent.com / s3.amazonaws.com iframe.
    // The NYT HIT content is in the iframe, so the auto-submit
    // happens there.
    // ---------------------------------------------------------
    else if (isHitPage) {

        // Top window only: record this HIT's path key in sessionStorage
        // the moment the task page loads. The key is read straight from
        // the URL path (the route MTurk itself uses), so unlike the old
        // URL-fragment trick it can't be stripped by MTurk's SPA router.
        // It persists in sessionStorage across the post-submit
        // navigation so Phase 0 can broadcast it to the queue tab.
        if (!isMturkIframe) {
            try {
                const key = extractHitKey(window.location.href);
                if (key) sessionStorage.setItem(HIT_KEY_SESSION_KEY, key);
            } catch (e) {}
        }

        let hasSubmitted = false;

        const processTaskContent = () => {
            if (hasSubmitted) return true;
            if (!document.body) return false;

            // 1. Verify NYT HIT
            const pageText = document.body.textContent.replace(/\s+/g, ' ');
            if (!pageText.includes("While reading the article preview")) return false;

            // 2. Find checkboxes
            const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"], crowd-checkbox'));
            if (allCheckboxes.length === 0) return false;

            // 3. Click a random checkbox
            allCheckboxes[Math.floor(Math.random() * allCheckboxes.length)].click();
            hasSubmitted = true;

            // 4. Scroll to bottom
            window.scrollTo(0, document.body.scrollHeight);

            // 5. Random delay before submit (2.5s - 4.5s)
            const randomDelay = Math.floor(Math.random() * (4500 - 2500 + 1)) + 2500;

            setTimeout(() => {
                const submitBtn = document.querySelector(
                    'input[type="submit"], button[type="submit"], .submit-btn, #submitButton, crowd-button[form-action="submit"]'
                );

                if (submitBtn) {
                    submitBtn.click();
                } else {
                    for (const btn of document.querySelectorAll('button, crowd-button')) {
                        if (btn.textContent.toLowerCase().includes('submit')) {
                            btn.click();
                            break;
                        }
                    }
                }
                // No redirect here - MTurk navigates the top window
                // to the post-submit page, and Phase 0 closes it.
            }, randomDelay);

            return true;
        };

        // Cap the polling so that a non-NYT HIT (e.g. one a worker
        // opened manually via PCM) doesn't keep an interval running
        // indefinitely. 180 ticks (~3 min) is more than enough time
        // for any NYT iframe to render and for us to act on it.
        let pollTicks = 0;
        const MAX_POLL_TICKS = 180;
        const taskInterval = setInterval(() => {
            pollTicks++;
            if (pollTicks >= MAX_POLL_TICKS || processTaskContent()) {
                clearInterval(taskInterval);
            }
        }, 1000);
    }
})();
