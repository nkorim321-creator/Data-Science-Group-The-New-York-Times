// ==UserScript==
// @name         MTurk Automation - NYT (BST Time-Window Reload & Fast Return)
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  Automates NYT HITs on MTurk: BST time-windowed queue reload (every 1 min during specific windows), opens detected NYT HITs in NEW background tabs (queue tab stays put), random checkbox select + submit in the new tab, instant-close the post-submit tab, instant-close any duplicate /tasks tab, blank-page recovery.
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

    // Open a URL in a new background tab. Uses GM_openInTab when
    // available (Tampermonkey/Violentmonkey - bypasses popup blocker
    // even when not triggered by a user gesture, which matters because
    // we open from a MutationObserver callback). Falls back to
    // window.open.
    const openTabInBackground = (url) => {
        try {
            if (typeof GM_openInTab === 'function') {
                GM_openInTab(url, { active: false, insert: true, setParent: true });
                return;
            }
        } catch (e) {}
        try { window.open(url, '_blank'); } catch (e) {}
    };

    // Close the current tab instantly, no warning page, no delay.
    // Tries multiple methods in order; whichever the userscript
    // engine + browser allows wins. At least one usually works.
    //   1. GM_closeBrowserTab          - Tampermonkey/Violentmonkey API,
    //                                    closes any tab regardless of
    //                                    how it was opened (needs the
    //                                    @grant approval in Tampermonkey)
    //   2. window.open('','_self')     - claims this window as script-
    //                                    opened in some Chrome versions,
    //                                    unlocking window.close()
    //   3. window.close()              - native close; works for tabs
    //                                    the browser treats as script-
    //                                    opened (PCM window.open tabs)
    //   4. window.top.close()          - same as 3 but on the top window
    //   5. unsafeWindow.close()        - bypasses Tampermonkey's sandbox
    //                                    proxy, useful when @grant
    //                                    sandbox swaps window
    const closeThisTabNow = () => {
        try {
            if (typeof GM_closeBrowserTab !== 'undefined') {
                GM_closeBrowserTab();
            }
        } catch (e) {}
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

        const existing = readPrimary();
        if (existing && existing.tabId !== myTabId) {
            closeThisTabNow();
            return;
        }

        writePrimary();
        setInterval(() => {
            const current = readPrimary();
            if (current && current.tabId !== myTabId) {
                closeThisTabNow();
                return;
            }
            writePrimary();
        }, HEARTBEAT_MS);

        window.addEventListener('beforeunload', () => {
            try {
                const data = JSON.parse(localStorage.getItem(PRIMARY_KEY) || 'null');
                if (data && data.tabId === myTabId) localStorage.removeItem(PRIMARY_KEY);
            } catch (e) {}
        });

        const PAGE_LOAD_TIME = Date.now();
        const RELOAD_INTERVAL_MS = 60 * 1000;
        // Track HIT URLs we've already opened during this page session so
        // we don't keep re-opening the same one as the queue re-scans.
        // Resets on every page reload, which is fine because by then any
        // accepted HIT is no longer in the queue.
        const openedHits = new Set();

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
                openTabInBackground(absoluteUrl);
            }
        };

        // Observer keeps running for the lifetime of this /tasks page -
        // every time the queue updates we re-scan and open any new NYT
        // HITs in fresh background tabs. The queue tab itself never
        // navigates away.
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

        // Reload loop: ticks every 1 s. Reload only when (a) inside a
        // BST window AND (b) 60 s elapsed since load. Outside windows
        // the queue tab stays idle.
        const reloadTick = () => {
            if (!isInReloadWindow()) return;
            if (Date.now() - PAGE_LOAD_TIME < RELOAD_INTERVAL_MS) return;
            window.location.reload();
        };
        setInterval(reloadTick, 1000);

        // Backup: when tab becomes visible after being hidden, re-check immediately
        // (handles background-tab setTimeout/setInterval throttling).
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) reloadTick();
        });

        // ---------------------------------------------------------
        // Blank-page recovery: MTurk sometimes renders /tasks as a
        // completely blank white page on certain Worker IDs. Check
        // 4 s after load, and re-check every 15 s thereafter, in
        // case the page goes blank later. Reload aggressively
        // (up to MAX_BLANK_RELOADS times) until the page renders
        // properly. Counter resets the moment the page looks loaded.
        // ---------------------------------------------------------
        const BLANK_CHECK_DELAY_MS = 4000;
        const BLANK_RECHECK_MS = 15000;
        const MAX_BLANK_RELOADS = 100;
        const BLANK_RELOAD_KEY = '__nyt_userscript_blank_count__';

        const pageLooksLoaded = () => {
            const text = document.body ? document.body.textContent : '';
            // A real /tasks page has a substantial amount of text plus
            // recognizable queue markers. The blank state shows almost
            // no text at all.
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
                // After repeated failures, cache-bust the URL to force a fresh fetch
                window.location.href = QUEUE_URL + '?_t=' + Date.now();
            }
        };

        setTimeout(recoverFromBlank, BLANK_CHECK_DELAY_MS);
        // Keep checking every 15 s in case the page renders fine at
        // first but goes blank later (rare but reported).
        setInterval(recoverFromBlank, BLANK_RECHECK_MS);
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
