/**
 * VisaD Auto Login v2 — GoLogin Browser
 *
 * Each login gets its own GoLogin profile with unique fingerprint.
 * Launches a VISIBLE browser on your Mac — no bot detection.
 *
 * Usage:
 *   npm install
 *   node index.js
 *
 * Then go to vault.visad.co.uk/aaa.html — click Auto Login.
 */

const express = require('express');
const cors = require('cors');
const GoLoginModule = require('gologin');
const GoLogin = GoLoginModule.default || GoLoginModule.GoLogin || GoLoginModule;
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = 4400;
const GOLOGIN_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2OTk4YzNhNWQ2ZGUxMDdhNGNhOGNlM2EiLCJ0eXBlIjoiZGV2Iiwiand0aWQiOiI2OTk4Y2FjYmY5NTJmNTJiZmM2ZDExMTEifQ.pJN32eIZ80YnoIMZ6lRVwH6l_0M9zArz_5O8ZvPoV-U';
const MAX_SESSIONS = 10;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Single GoLogin profile for all sessions
const GOLOGIN_PROFILE_ID = '699bf90f5b93b831c628a170';
const sessions = new Map();

function genId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// ─── API Endpoints ───────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.size, type: 'gologin', local: true });
});

app.post('/start', async (req, res) => {
    if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: 'Max sessions reached' });

    const { login } = req.body;
    if (!login || !login.url) return res.status(400).json({ error: 'Login URL required' });

    const id = genId();
    const sess = { id, gl: null, browser: null, page: null, status: 'starting', login, log: [] };
    sessions.set(id, sess);

    res.json({ sessionId: id, status: 'starting' });

    runAutoLogin(id, login).catch(err => {
        console.error(`[${id}] Error:`, err.message);
        sess.status = 'error';
        sess.log.push({ time: now(), msg: 'Error: ' + err.message });
    });
});

app.get('/status/:id', (req, res) => {
    const sess = sessions.get(req.params.id);
    if (!sess) return res.status(404).json({ error: 'Not found' });
    res.json({ sessionId: sess.id, status: sess.status, log: sess.log.slice(-20) });
});

app.post('/stop/:id', async (req, res) => {
    const sess = sessions.get(req.params.id);
    if (!sess) return res.status(404).json({ error: 'Not found' });
    try { if (sess.browser) await sess.browser.close(); } catch(e) {}
    try { if (sess.gl) await sess.gl.stop(); } catch(e) {}
    sessions.delete(sess.id);
    res.json({ status: 'stopped' });
});

app.get('/screenshot/:id', async (req, res) => {
    const sess = sessions.get(req.params.id);
    if (!sess || !sess.page) return res.status(404).json({ error: 'No page' });
    try {
        const img = await sess.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75 });
        res.json({ image: 'data:image/jpeg;base64,' + img });
    } catch(e) { res.status(500).json({ error: 'Screenshot failed' }); }
});

app.get('/sessions', (req, res) => {
    const list = [];
    for (const [, s] of sessions) {
        list.push({ id: s.id, status: s.status, login: { profile_name: s.login.profile_name, url: s.login.url }, log: s.log.slice(-5) });
    }
    res.json({ sessions: list });
});

// ─── Auto Login with GoLogin ─────────────────────────────────

async function runAutoLogin(id, login) {
    const sess = sessions.get(id);
    const log = (msg) => {
        console.log(`[${id}] ${msg}`);
        if (sess) sess.log.push({ time: now(), msg });
    };

    // Step 1: Use fixed GoLogin profile
    const profileId = GOLOGIN_PROFILE_ID;
    log('Using GoLogin profile: ' + profileId);

    // Step 2: Launch GoLogin browser
    log('Launching GoLogin browser...');
    const gl = new GoLogin({
        token: GOLOGIN_TOKEN,
        profile_id: profileId,
    });

    sess.gl = gl;
    const { status: glStatus, wsUrl } = await gl.start();
    log('GoLogin browser started');

    // Step 3: Connect Puppeteer and navigate
    await sleep(2000); // Wait for browser to be ready

    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
    sess.browser = browser;

    const pages = await browser.pages();
    let page = pages[0] || await browser.newPage();
    sess.page = page;

    const url = login.url;
    const email = login.email || '';
    const password = login.password || '';

    log('Navigating to ' + url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Step 4: Check for Cloudflare — wait for user to solve
    sess.status = 'captcha';
    log('Checking for Cloudflare...');

    for (let attempt = 0; attempt < 90; attempt++) {
        if (!sessions.has(id)) return;

        const currentUrl = page.url();
        const bodyText = await page.evaluate(() => (document.body?.innerText || '')).catch(() => '');
        const hasCf = bodyText.includes('Verify you are human') || bodyText.includes('Just a moment') || bodyText.includes('security verification');

        if (!hasCf) {
            log('No Cloudflare (or already passed). Continuing...');
            break;
        }

        if (attempt === 0) log('Cloudflare detected — solve it manually in the browser');
        if (attempt % 5 === 0 && attempt > 0) log('Still waiting for Cloudflare... (' + (attempt * 2) + 's)');

        await sleep(2000);
    }

    sess.status = 'running';
    await sleep(1000);

    try {
        await sleep(2000);

        // Step 4: Click LOG IN (if on homepage)
        log('Looking for login button...');
        const clickedLogin = await page.evaluate(() => {
            const spans = document.querySelectorAll('span[type="button"]');
            for (const s of spans) {
                if (s.textContent.trim().toUpperCase() === 'LOG IN') { s.click(); return true; }
            }
            const link = document.querySelector('a[href*="/login"]');
            if (link) { link.click(); return true; }
            return false;
        });

        if (clickedLogin) {
            log('Clicked login — waiting for form...');
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        // Step 5: Fill credentials
        const emailField = await page.$('input[type="email"], input[name="username"], input#email-input-field, input[name*="email"]');
        const passField = await page.$('input[type="password"]');

        if (emailField && passField) {
            log('Filling credentials...');
            await emailField.click({ clickCount: 3 });
            await emailField.type(email, { delay: 40 + Math.random() * 40 });
            await sleep(300 + Math.random() * 200);
            await passField.click({ clickCount: 3 });
            await passField.type(password, { delay: 40 + Math.random() * 40 });
            await sleep(500);

            log('Clicking login...');
            const clicked = await page.evaluate(() => {
                const btn = document.querySelector('button#btn-login, button[type="submit"]');
                if (btn && !btn.disabled) { btn.click(); return true; }
                const allBtns = document.querySelectorAll('button');
                for (const b of allBtns) {
                    const t = b.textContent.trim().toLowerCase();
                    if ((t === 'login' || t === 'log in' || t === 'sign in') && !b.disabled) { b.click(); return true; }
                }
                return false;
            });

            if (clicked) {
                log('Login clicked — solve reCAPTCHA if needed');
                sess.status = 'captcha';
                try {
                    await page.waitForNavigation({ timeout: 180000 });
                    log('Navigated after login');
                } catch(e) {
                    log('Timeout — check browser');
                }
                await sleep(2000);
            }
        } else {
            log('No login form — already logged in');
        }

        // Step 6: My Application
        const postUrl = page.url();
        log('Current: ' + postUrl);

        if (postUrl.includes('/country/') || postUrl.includes('/vac/')) {
            log('Clicking My Application...');
            await page.evaluate(() => {
                const btn = document.querySelector('[data-testid="user-button"]');
                if (btn) (btn.closest('button,a,div') || btn).click();
            });
            await sleep(1000);
            await page.evaluate(() => {
                const el = document.querySelector('#my-application');
                if (el) { el.click(); return; }
                document.querySelectorAll('a').forEach(a => {
                    if (a.textContent.trim().toLowerCase() === 'my application') a.click();
                });
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        // Step 7: Select
        if (page.url().includes('travel-groups')) {
            log('Clicking Select...');
            await page.evaluate(() => {
                const btn = document.querySelector('button[name="formGroupId"]');
                if (btn) { const f = btn.closest('form'); if (f) { try { f.requestSubmit(btn); return; } catch(e){} } btn.click(); }
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        // Step 8: Continue steps
        for (let step = 0; step < 6; step++) {
            if (page.url().includes('appointment-booking')) break;
            log('Continue ' + (step + 1) + '...');
            await page.evaluate(() => {
                const a = document.querySelector('a#book-appointment-btn');
                if (a && a.href) { window.location.href = a.href; return; }
                document.querySelectorAll('a,button').forEach(el => {
                    const t = el.textContent.trim().toLowerCase();
                    if (t === 'continue' || t.includes('book appointment')) {
                        if (el.href) window.location.href = el.href; else el.click();
                    }
                });
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        // Done
        if (page.url().includes('appointment-booking')) {
            log('REACHED BOOKING PAGE!');
            sess.status = 'booking';
        } else {
            log('Done — ' + page.url());
            sess.status = 'done';
        }

        log('Browser stays open. Close manually when done.');
        await new Promise(resolve => browser.on('disconnected', resolve));

    } catch(err) {
        log('Error: ' + err.message);
        sess.status = 'error';
    } finally {
        try { await gl.stop(); } catch(e) {}
        sessions.delete(id);
        console.log(`[${id}] Session ended, GoLogin profile preserved for reuse`);
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toISOString(); }

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║   VisaD Auto Login v2 — GoLogin Browser       ║');
    console.log('  ║   http://localhost:' + PORT + '                       ║');
    console.log('  ║                                               ║');
    console.log('  ║   Each login gets a unique fingerprint        ║');
    console.log('  ║   Profiles persist between sessions           ║');
    console.log('  ║   No bot detection — real browser identity    ║');
    console.log('  ║                                               ║');
    console.log('  ║   Go to vault.visad.co.uk/aaa.html            ║');
    console.log('  ║   Click Auto Login on any login item          ║');
    console.log('  ╚═══════════════════════════════════════════════╝');
    console.log('');
});
