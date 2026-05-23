// ==UserScript==
// @name         MTurk Automation - NYT (BST Time-Window Reload & Fast Return)
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Automates NYT HITs on MTurk: BST time-windowed queue reload (every 1 min during specific windows), random checkbox select, post-submit auto-redirect to /tasks for our auto-submits, instant-close the post-submit tab for manual submits, instant-close any duplicate /tasks tab, auto-work on 2nd HIT from same requester, blank-page recovery.
// @author       You
// @match        https://worker.mturk.com/*
// @match        https://*.mturkcontent.com/*
// @match        https://*.s3.amazonaws.com/*
// @grant        GM_closeBrowserTab
// @updateURL    https://raw.githubusercontent.com/nkorim321-creator/Data-Science-Group-The-New-York-Times/main/DS.user.js
// @downloadURL  https://raw.githubusercontent.com/nkorim321-creator/Data-Science-Group-The-New-York-Times/main/DS.user.js
// ==/UserScript==

(function() {
    'use strict';

    const TARGET_REQUESTER = "Data Science Group, The New York Times";
    const QUEUE_URL = "https://worker.mturk.com/tasks";
    const currentUrl = window.location.href;
    // Marker our script writes (via postMessage from iframe -> top window) just
    // before auto-submitting an NYT HIT. Phase 0 only redirects to /tasks when
    // this marker is fresh, so manual submits of other requesters' HITs do not
    // get hijacked.
    const AUTO_SUBMIT_FLAG_KEY = '__nyt_auto_submit_flag__';
    const AUTO_SUBMIT_FLAG_TTL_MS = 15000;
    const AUTO_SUBMIT_MESSAGE_TYPE = '__nyt_auto_submit__';

    // Close the current tab instantly, no warning page, no delay.
    // GM_closeBrowserTab (Tampermonkey/Violentmonkey) can close any
    // tab; window.close() is a fallback for tabs the userscript
    // engine considers script-opened.
    const closeThisTabNow = () => {
        try {
            if (typeof GM_closeBrowserTab === 'function') {
                GM_closeBrowserTab();
                return;
            }
        } catch (e) {}
        try { window.close(); } catch (e) {}
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
    // act on the post-submit tab:
    //   * AUTO_SUBMIT_FLAG_KEY fresh -> redirect to /tasks
    //     (keeps the queue tab alive so it can pick up the next HIT)
    //   * otherwise -> close the tab instantly
    //     (post-submit landing page for any manual submit)
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
                    const flagTime = parseInt(sessionStorage.getItem(AUTO_SUBMIT_FLAG_KEY) || '0', 10);
                    const autoSubmitFresh = flagTime && (Date.now() - flagTime < AUTO_SUBMIT_FLAG_TTL_MS);
                    if (autoSubmitFresh) {
                        sessionStorage.removeItem(AUTO_SUBMIT_FLAG_KEY);
                        window.location.href = QUEUE_URL;
                    } else {
                        closeThisTabNow();
                    }
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
        // ---------------------------------------------------------
        const PRIMARY_KEY = '__nyt_tasks_primary__';
        const STALE_MS = 5000;
        const HEARTBEAT_MS = 1500;
        const myTabId = Date.now() + '-' + Math.random().toString(36).slice(2, 11);

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

        let workClicked = false;
        const PAGE_LOAD_TIME = Date.now();
        const RELOAD_INTERVAL_MS = 60 * 1000;

        const scanQueueForRequester = () => {
            if (workClicked) return true;

            const rows = document.querySelectorAll(
                '.project-detail-bar, .table-row, tr, li.task-row, ' +
                'div[class*="task-row"], div[class*="project-detail"]'
            );

            for (const row of rows) {
                if (!row.textContent || !row.textContent.includes(TARGET_REQUESTER)) continue;

                const workButton = row.querySelector(
                    'a[href*="/projects/"][href*="/tasks/accept"], ' +
                    'a.btn[href*="/projects/"], ' +
                    'a[class*="work"][href*="/projects/"], ' +
                    'button[class*="work"]'
                );

                if (workButton) {
                    workClicked = true;
                    workButton.click();
                    return true;
                }
            }
            return false;
        };

        const queueObserver = new MutationObserver(() => {
            if (scanQueueForRequester()) queueObserver.disconnect();
        });

        const startScanning = () => {
            if (!document.body) {
                setTimeout(startScanning, 50);
                return;
            }
            queueObserver.observe(document.body, { childList: true, subtree: true });
            scanQueueForRequester();
        };
        startScanning();

        // Reload loop: ticks every 1s.
        // Reload only when (a) inside a BST window AND (b) 60s elapsed since load
        // AND (c) we haven't clicked a HIT yet. Outside windows = page stays idle.
        const reloadTick = () => {
            if (workClicked) return;
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
        // completely blank white page on certain Worker IDs. After
        // BLANK_CHECK_DELAY_MS we look for any expected queue content;
        // if missing, reload. Attempts capped to avoid infinite loops.
        // ---------------------------------------------------------
        const BLANK_CHECK_DELAY_MS = 6000;
        const MAX_BLANK_RELOADS = 5;
        const BLANK_RELOAD_KEY = '__nyt_userscript_blank_count__';

        const recoverFromBlank = () => {
            if (workClicked) return;

            const text = document.body ? document.body.textContent : '';
            const looksLoaded =
                text.includes('HITs Queue') ||
                text.includes('Your HITs') ||
                text.includes('Requester') ||
                text.includes('Browse all available HITs') ||
                document.querySelector('header, .navbar, .table, table, .task-row, [class*="HitSet"]');

            if (looksLoaded) {
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
    }

    // ---------------------------------------------------------
    // PHASE 2: HIT page - auto-select checkbox, submit, redirect to queue
    //
    // The script runs in BOTH the worker.mturk.com top window AND the
    // cross-origin mturkcontent.com / s3.amazonaws.com iframe. The NYT
    // HIT content is in the iframe, so the auto-submit happens there.
    //
    // Just before auto-submitting, the iframe postMessages the top
    // window so the top window can write AUTO_SUBMIT_FLAG_KEY into
    // worker.mturk.com's sessionStorage. That flag is what Phase 0
    // uses to distinguish our auto-submits from the worker's own
    // manual submits of other requesters' HITs (which must NOT be
    // redirected to /tasks, or they'd duplicate the always-open queue).
    // ---------------------------------------------------------
    else if (isHitPage) {

        // Top window of the HIT page: receive the iframe's signal and
        // record the flag in worker.mturk.com's sessionStorage so it
        // survives the navigation MTurk does after the form submits.
        if (!isMturkIframe) {
            window.addEventListener('message', (event) => {
                if (event && event.data && event.data.type === AUTO_SUBMIT_MESSAGE_TYPE) {
                    try {
                        sessionStorage.setItem(AUTO_SUBMIT_FLAG_KEY, Date.now().toString());
                    } catch (e) {}
                }
            });
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
                // Signal top window: we're about to auto-submit an NYT HIT.
                // Phase 0 will read the resulting sessionStorage flag and
                // redirect to /tasks after MTurk navigates the top window.
                try {
                    window.top.postMessage({ type: AUTO_SUBMIT_MESSAGE_TYPE }, '*');
                } catch (e) {}
                // Same-origin top window can also write the flag directly.
                try {
                    if (window.top === window) {
                        sessionStorage.setItem(AUTO_SUBMIT_FLAG_KEY, Date.now().toString());
                    }
                } catch (e) {}

                const submitBtn = document.querySelector(
                    'input[type="submit"], button[type="submit"], .submit-btn, #submitButton, crowd-button[form-action="submit"]'
                );

                let isClicked = false;
                if (submitBtn) {
                    submitBtn.click();
                    isClicked = true;
                } else {
                    for (const btn of document.querySelectorAll('button, crowd-button')) {
                        if (btn.textContent.toLowerCase().includes('submit')) {
                            btn.click();
                            isClicked = true;
                            break;
                        }
                    }
                }

                // 6. After submit -> queue page. Phase 1 picks up 2nd HIT if available.
                if (isClicked) {
                    setTimeout(() => {
                        try {
                            window.top.location.href = QUEUE_URL;
                        } catch (e) {
                            window.location.href = QUEUE_URL;
                        }
                    }, 800);
                }
            }, randomDelay);

            return true;
        };

        const taskInterval = setInterval(() => {
            if (processTaskContent()) clearInterval(taskInterval);
        }, 1000);
    }
})();
