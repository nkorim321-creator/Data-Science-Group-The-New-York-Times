// ==UserScript==
// @name         MTurk Automation - NYT (Auto-Reload & Fast Return)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Automates working NYT HITs, selects Checkboxes, 3-min auto-reload queue, and fast-returns to queue.
// @author       You
// @match        https://worker.mturk.com/tasks*
// @match        https://worker.mturk.com/projects/*/tasks/*
// @match        https://*.mturkcontent.com/*
// @match        https://*.s3.amazonaws.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const TARGET_REQUESTER = "Data Science Group, The New York Times";
    const QUEUE_URL = "https://worker.mturk.com/tasks";
    const currentUrl = window.location.href;

    // ---------------------------------------------------------
    // PHASE 1: Queue Automation & 3-Minute Auto-Reload
    // ---------------------------------------------------------
    if (currentUrl.includes('worker.mturk.com/tasks') && !currentUrl.includes('/projects/')) {

        // 3 minute por por page automatic reload hobe jodi kaj na thake
        setTimeout(() => {
            window.location.reload();
        }, 3 * 60 * 1000); // 3 minutes = 180000ms

        const scanQueueForRequester = () => {
            const rows = document.querySelectorAll('.table-row, tr, li.table-row, div[class*="table-row"]');

            for (let row of rows) {
                if (row.textContent.includes(TARGET_REQUESTER)) {
                    const workButton = row.querySelector('a[href*="/projects/"], button.work-btn, a[class*="work-btn"]');
                    if (workButton && workButton.textContent.toLowerCase().includes('work')) {
                        workButton.click();
                        return true;
                    }
                }
            }
            return false;
        };

        const queueObserver = new MutationObserver((mutations, obs) => {
            if (scanQueueForRequester()) {
                obs.disconnect();
            }
        });

        queueObserver.observe(document.body, { childList: true, subtree: true });
        scanQueueForRequester();
    }

    // ---------------------------------------------------------
    // PHASE 2: HIT Automation & Fast Redirect
    // ---------------------------------------------------------
    else {
        let hasSubmitted = false;

        const processTaskContent = () => {
            if (hasSubmitted) return true;

            // ১. পেজের টেক্সট ভেরিফাই করা
            const pageText = document.body.textContent.replace(/\s+/g, ' ');
            if (!pageText.includes("While reading the article preview")) {
                return false;
            }

            // ২. চেকবক্স (Checkbox) স্ক্যান করা
            const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"], crowd-checkbox'));

            if (allCheckboxes.length === 0) return false;

            // ৩. র‍্যান্ডমলি যেকোনো একটি চেকবক্সে ক্লিক করা
            const randomIndex = Math.floor(Math.random() * allCheckboxes.length);
            allCheckboxes[randomIndex].click();
            hasSubmitted = true;

            // ৪. নিচে স্ক্রল করা
            window.scrollTo(0, document.body.scrollHeight);

            // ৫. Random delay (2500ms - 4500ms) দিয়ে সাবমিট করা
            const randomDelay = Math.floor(Math.random() * (4500 - 2500 + 1)) + 2500;

            setTimeout(() => {
                const submitBtn = document.querySelector(
                    'input[type="submit"], button[type="submit"], .submit-btn, #submitButton, crowd-button[form-action="submit"]'
                );

                let isClicked = false;

                if (submitBtn) {
                    submitBtn.click();
                    isClicked = true;
                } else {
                    const allBtns = document.querySelectorAll('button, crowd-button');
                    for (let btn of allBtns) {
                        if (btn.textContent.toLowerCase().includes('submit')) {
                            btn.click();
                            isClicked = true;
                            break;
                        }
                    }
                }

                // ৬. সাবমিট হওয়ার সাথে সাথে (মাত্র ৮০০ms পর) Queue পেজে ফিরে যাওয়া
                if (isClicked) {
                    setTimeout(() => {
                        window.top.location.href = QUEUE_URL;
                    }, 800); // Khub druto redirect hobe data safe rekhe
                }

            }, randomDelay);

            return true;
        };

        const taskInterval = setInterval(() => {
            if (processTaskContent()) {
                clearInterval(taskInterval);
            }
        }, 1000);
    }
})();
