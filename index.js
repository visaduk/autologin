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

// profileName → GoLogin profile ID (persisted across restarts)
const profileCache = {};
const sessions = new Map();

function genId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// ─── GoLogin Profile Management ──────────────────────────────

async function getOrCreateProfile(loginName) {
    // Reuse existing profile for same login name
    const cacheKey = (loginName || 'default').replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 50);

    if (profileCache[cacheKey]) {
        console.log(`[GoLogin] Reusing profile ${profileCache[cacheKey]} for "${cacheKey}"`);
        return profileCache[cacheKey];
    }

    // Create new GoLogin profile via REST API directly
    console.log(`[GoLogin] Creating new profile for "${cacheKey}"...`);
    try {
        const resp = await fetch('https://api.gologin.com/browser', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + GOLOGIN_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: 'VisaD-' + cacheKey,
                browserType: 'chrome',
                os: 'mac',
                navigator: {
                    language: 'en-GB,en',
                    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    resolution: '1366x768',
                    platform: 'MacIntel'
                },
                proxyEnabled: false,
                proxy: { mode: 'none' }
            })
        });

        const text = await resp.text();
        console.log('[GoLogin] API response status:', resp.status, 'body:', text.substring(0, 500));

        let data;
        try { data = JSON.parse(text); } catch(e) {
            throw new Error('Invalid JSON response: ' + text.substring(0, 200));
        }

        if (data.id) {
            profileCache[cacheKey] = data.id;
            console.log(`[GoLogin] Created profile ${data.id}`);
            return data.id;
        }

        throw new Error('API error: ' + (data.message || data.error || text.substring(0, 200)));
    } catch (err) {
        console.error('[GoLogin] Profile creation failed:', err.message);
        throw new Error('GoLogin: ' + err.message);
    }
}

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

    // Step 1: Get or create GoLogin profile
    log('Getting GoLogin profile...');
    let profileId;
    try {
        profileId = await getOrCreateProfile(login.profile_name || login.email || 'default');
    } catch (err) {
        log('Failed to get GoLogin profile: ' + err.message);
        sess.status = 'error';
        return;
    }

    // Step 2: Launch GoLogin browser (visible) — navigate to URL directly
    // Do NOT connect Puppeteer yet — let user pass Cloudflare first
    log('Launching GoLogin browser (profile: ' + profileId + ')...');
    const gl = new GoLogin({
        token: GOLOGIN_TOKEN,
        profile_id: profileId,
        extra_params: [
            '--window-size=1366,900',
            '--disable-infobars',
            '--no-first-run',
            login.url  // Open URL directly — no Puppeteer automation flags
        ]
    });

    sess.gl = gl;
    const { status: glStatus, wsUrl } = await gl.start();
    log('GoLogin started — browser opened with URL');

    // Step 3: Wait for user to pass Cloudflare manually
    sess.status = 'captcha';
    log('WAITING: Pass Cloudflare verification in the browser, then automation will continue...');

    // Poll: connect Puppeteer once Cloudflare is passed (page has actual TLS content)
    let browser = null;
    let page = null;
    let connected = false;

    for (let attempt = 0; attempt < 90; attempt++) { // Wait up to 3 minutes
        await sleep(2000);

        if (!sessions.has(id)) return; // Session was stopped

        try {
            if (!browser) {
                browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
                sess.browser = browser;
            }

            const pages = await browser.pages();
            page = pages.find(p => p.url().includes('tlscontact.com') || p.url().includes('vfsglobal.com')) || pages[pages.length - 1];
            sess.page = page;

            // Check if past Cloudflare
            const pageContent = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            const hasCf = pageContent.includes('Verify you are human') || pageContent.includes('security verification') || pageContent.includes('Just a moment');

            if (!hasCf && page.url().includes('tlscontact.com')) {
                connected = true;
                log('Cloudflare passed! Starting automation...');
                break;
            }

            if (attempt % 5 === 0) {
                log('Still waiting for Cloudflare... (' + (attempt * 2) + 's)');
            }
        } catch(e) {
            // Puppeteer connection failed — browser may not be ready yet
            if (attempt % 10 === 0) log('Waiting for browser... ' + e.message);
        }
    }

    if (!connected) {
        log('Timeout waiting for Cloudflare — browser stays open for manual use');
        sess.status = 'done';
        if (browser) await new Promise(resolve => browser.on('disconnected', resolve));
        try { await gl.stop(); } catch(e) {}
        sessions.delete(id);
        return;
    }

    sess.status = 'running';
    const url = login.url;
    const email = login.email || '';
    const password = login.password || '';

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
