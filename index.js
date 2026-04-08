/**
 * VisaD Auto Login v3 — Stealth Chrome
 *
 * Uses puppeteer-extra-plugin-stealth to bypass Cloudflare Turnstile.
 * Opens a VISIBLE Chrome with fresh profile per login.
 *
 * Stealth techniques:
 *   - Removes navigator.webdriver flag
 *   - Patches Chrome.runtime
 *   - Fixes iframe contentWindow
 *   - Spoofs WebGL vendor/renderer
 *   - Consistent navigator properties
 *   - Removes automation Chrome flags
 *   - User-like mouse movements
 *
 * Usage:
 *   npm install
 *   node index.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Apply ALL stealth evasions
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 4400;
const PROFILES_DIR = path.join(__dirname, '.profiles');
const MAX_SESSIONS = 10;

if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

app.use(cors({ origin: '*' }));
app.use(express.json());

const sessions = new Map();
function genId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// ─── API ─────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.size, type: 'stealth', local: true });
});

app.post('/start', async (req, res) => {
    if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: 'Max sessions' });
    const { login } = req.body;
    if (!login || !login.url) return res.status(400).json({ error: 'URL required' });

    const id = genId();
    sessions.set(id, { id, browser: null, page: null, status: 'starting', login, log: [] });
    res.json({ sessionId: id, status: 'starting' });

    runAutoLogin(id, login).catch(err => {
        console.error(`[${id}] Fatal:`, err.message);
        const s = sessions.get(id);
        if (s) { s.status = 'error'; s.log.push({ time: now(), msg: err.message }); }
    });
});

app.get('/status/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ sessionId: s.id, status: s.status, log: s.log.slice(-20) });
});

app.post('/stop/:id', async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    try { if (s.browser) await s.browser.close(); } catch(e) {}
    sessions.delete(s.id);
    cleanup(path.join(PROFILES_DIR, s.id));
    res.json({ status: 'stopped' });
});

app.get('/screenshot/:id', async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || !s.page) return res.status(404).json({ error: 'No page' });
    try {
        const img = await s.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75 });
        res.json({ image: 'data:image/jpeg;base64,' + img });
    } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/sessions', (req, res) => {
    const list = [];
    for (const [, s] of sessions) list.push({ id: s.id, status: s.status, login: { profile_name: s.login.profile_name, url: s.login.url }, log: s.log.slice(-5) });
    res.json({ sessions: list });
});

// ─── Stealth Auto Login ──────────────────────────────────────

async function runAutoLogin(id, login) {
    const sess = sessions.get(id);
    const log = (msg) => {
        console.log(`[${id}] ${msg}`);
        if (sess) sess.log.push({ time: now(), msg });
    };

    const profileDir = path.join(PROFILES_DIR, id);

    log('Launching stealth Chrome...');
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1366,900',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--flag-switches-begin', '--flag-switches-end',
            '--no-first-run',
            '--no-default-browser-check',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        userDataDir: profileDir,
        defaultViewport: null
    });

    sess.browser = browser;
    const page = (await browser.pages())[0] || await browser.newPage();
    sess.page = page;

    // Extra stealth: override webdriver at page level
    await page.evaluateOnNewDocument(() => {
        // Remove webdriver flag
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Fake plugins
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        // Fake languages
        Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
        // Chrome runtime
        window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
        // Permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters);
    });

    const url = login.url;
    const email = login.email || '';
    const password = login.password || '';

    try {
        // Navigate
        log('Opening ' + url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for Cloudflare to pass (auto or manual)
        log('Waiting for page to load (Cloudflare may appear)...');
        sess.status = 'captcha';

        for (let i = 0; i < 120; i++) { // 4 min max
            await sleep(2000);
            if (!sessions.has(id)) return;

            const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            const pageUrl = page.url();
            const hasCf = bodyText.includes('Verify you are human') || bodyText.includes('Just a moment') || bodyText.includes('security verification');

            if (!hasCf && (pageUrl.includes('tlscontact.com') || pageUrl.includes('vfsglobal.com'))) {
                log('Page loaded — no Cloudflare block!');
                break;
            }

            // Try clicking Cloudflare checkbox automatically
            if (hasCf && i > 2) {
                try {
                    const cfFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
                    if (cfFrame) {
                        const checkbox = await cfFrame.$('input[type="checkbox"], .cb-lb');
                        if (checkbox) {
                            await humanClick(page, checkbox);
                            log('Clicked Cloudflare checkbox');
                            await sleep(3000);
                        }
                    }
                } catch(e) {}
            }

            if (i === 0) log('Cloudflare detected — attempting auto-solve...');
            if (i % 10 === 0 && i > 0) log('Waiting... (' + (i * 2) + 's) — solve manually if needed');
        }

        sess.status = 'running';
        await sleep(2000);

        // Click LOG IN
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

        // Fill credentials
        const emailField = await page.$('input[type="email"], input[name="username"], input#email-input-field, input[name*="email"]');
        const passField = await page.$('input[type="password"]');

        if (emailField && passField) {
            log('Filling credentials...');

            // Human-like: click field, small delay, type slowly
            await humanClick(page, emailField);
            await sleep(200);
            await page.keyboard.selectAll();
            await page.keyboard.type(email, { delay: 30 + Math.random() * 50 });

            await sleep(300 + Math.random() * 300);

            await humanClick(page, passField);
            await sleep(200);
            await page.keyboard.selectAll();
            await page.keyboard.type(password, { delay: 30 + Math.random() * 50 });

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
                try { await page.waitForNavigation({ timeout: 180000 }); log('Navigated'); } catch(e) { log('Timeout'); }
                await sleep(2000);
            }
        } else {
            log('No login form — already logged in');
        }

        // My Application
        sess.status = 'running';
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
                document.querySelectorAll('a').forEach(a => { if (a.textContent.trim().toLowerCase() === 'my application') a.click(); });
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        // Select
        if (page.url().includes('travel-groups')) {
            log('Clicking Select...');
            await page.evaluate(() => {
                const btn = document.querySelector('button[name="formGroupId"]');
                if (btn) { const f = btn.closest('form'); if (f) { try { f.requestSubmit(btn); return; } catch(e){} } btn.click(); }
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        // Continue steps
        for (let step = 0; step < 6; step++) {
            if (page.url().includes('appointment-booking')) break;
            log('Continue ' + (step + 1) + '...');
            await page.evaluate(() => {
                const a = document.querySelector('a#book-appointment-btn');
                if (a && a.href) { window.location.href = a.href; return; }
                document.querySelectorAll('a,button').forEach(el => {
                    const t = el.textContent.trim().toLowerCase();
                    if (t === 'continue' || t.includes('book appointment')) { if (el.href) window.location.href = el.href; else el.click(); }
                });
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

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
        try { if (browser.isConnected()) await browser.close(); } catch(e) {}
        sessions.delete(id);
        cleanup(profileDir);
        console.log(`[${id}] Session ended`);
    }
}

// Human-like click with random offset
async function humanClick(page, element) {
    try {
        const box = await element.boundingBox();
        if (!box) { await element.click(); return; }
        const x = box.x + box.width * (0.3 + Math.random() * 0.4);
        const y = box.y + box.height * (0.3 + Math.random() * 0.4);
        await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
        await sleep(50 + Math.random() * 100);
        await page.mouse.click(x, y);
    } catch(e) {
        await element.click();
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toISOString(); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {} }

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║   VisaD Auto Login v3 — Stealth Chrome        ║');
    console.log('  ║   http://localhost:' + PORT + '                       ║');
    console.log('  ║                                               ║');
    console.log('  ║   Stealth: webdriver hidden, fingerprint      ║');
    console.log('  ║   spoofed, automation flags removed           ║');
    console.log('  ║   Human-like mouse + typing                   ║');
    console.log('  ║                                               ║');
    console.log('  ║   Go to vault.visad.co.uk/aaa.html            ║');
    console.log('  ║   Click Auto Login on any login item          ║');
    console.log('  ╚═══════════════════════════════════════════════╝');
    console.log('');
});
