/**
 * VisaD Auto Login v4 — GoLogin (fresh profile per login)
 * Each login gets its own GoLogin profile with unique fingerprint.
 */

const GoLoginModule = require('gologin');
const GoLogin = GoLoginModule.default || GoLoginModule.GoLogin || GoLoginModule;
const puppeteer = require('puppeteer-core');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 4400;
const GOLOGIN_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2OTk4YzNhNWQ2ZGUxMDdhNGNhOGNlM2EiLCJ0eXBlIjoiZGV2Iiwiand0aWQiOiI2OTk4Y2FjYmY5NTJmNTJiZmM2ZDExMTEifQ.pJN32eIZ80YnoIMZ6lRVwH6l_0M9zArz_5O8ZvPoV-U';
const MAX_SESSIONS = 10;

app.use(cors({ origin: '*' }));
app.use(express.json());

const profileCache = {}; // loginName → profileId (reuse across restarts)
const sessions = new Map();
function genId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// ─── Create GoLogin profile via API ──────────────────────────
async function getOrCreateProfile(loginName) {
    const key = (loginName || 'default').replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 50);
    if (profileCache[key]) { console.log(`[GoLogin] Reusing profile ${profileCache[key]}`); return profileCache[key]; }

    console.log(`[GoLogin] Creating profile for "${key}"...`);
    const resp = await fetch('https://api.gologin.com/browser', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + GOLOGIN_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'VisaD-' + key,
            browserType: 'chrome',
            os: 'mac',
            navigator: { language: 'en-GB,en', resolution: '1366x768', platform: 'MacIntel' },
            proxyEnabled: false,
            proxy: { mode: 'none' }
        })
    });
    const data = await resp.json();
    if (data.id) { profileCache[key] = data.id; console.log(`[GoLogin] Created ${data.id}`); return data.id; }
    throw new Error('GoLogin API: ' + JSON.stringify(data).substring(0, 200));
}

// ─── API ─────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size, type: 'gologin', local: true }));

app.post('/start', async (req, res) => {
    if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: 'Max sessions' });
    const { login } = req.body;
    if (!login || !login.url) return res.status(400).json({ error: 'URL required' });
    const id = genId();
    sessions.set(id, { id, gl: null, browser: null, page: null, status: 'starting', login, log: [] });
    res.json({ sessionId: id, status: 'starting' });
    runAutoLogin(id, login).catch(err => {
        console.error(`[${id}] Fatal:`, err.message);
        const s = sessions.get(id); if (s) { s.status = 'error'; s.log.push({ time: now(), msg: err.message }); }
    });
});

app.get('/status/:id', (req, res) => { const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' }); res.json({ sessionId: s.id, status: s.status, log: s.log.slice(-20) }); });
app.post('/stop/:id', async (req, res) => { const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' }); try { if (s.browser) await s.browser.close(); } catch(e) {} try { if (s.gl) await s.gl.stop(); } catch(e) {} sessions.delete(s.id); res.json({ status: 'stopped' }); });
app.get('/screenshot/:id', async (req, res) => { const s = sessions.get(req.params.id); if (!s || !s.page) return res.status(404).json({ error: 'No page' }); try { const img = await s.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75 }); res.json({ image: 'data:image/jpeg;base64,' + img }); } catch(e) { res.status(500).json({ error: 'Failed' }); } });
app.get('/sessions', (req, res) => { const list = []; for (const [, s] of sessions) list.push({ id: s.id, status: s.status, login: { profile_name: s.login.profile_name, url: s.login.url }, log: s.log.slice(-5) }); res.json({ sessions: list }); });

// ─── Auto Login ──────────────────────────────────────────────
async function runAutoLogin(id, login) {
    const sess = sessions.get(id);
    const log = (msg) => { console.log(`[${id}] ${msg}`); if (sess) sess.log.push({ time: now(), msg }); };

    // Get/create profile
    log('Getting GoLogin profile...');
    let profileId;
    try { profileId = await getOrCreateProfile(login.profile_name || login.email || 'default'); }
    catch (err) { log('Profile error: ' + err.message); sess.status = 'error'; return; }

    // Launch GoLogin
    log('Launching GoLogin browser...');
    const gl = new GoLogin({ token: GOLOGIN_TOKEN, profile_id: profileId });
    sess.gl = gl;
    const { wsUrl } = await gl.start();
    log('GoLogin started');

    await sleep(2000);
    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
    sess.browser = browser;
    const page = (await browser.pages())[0] || await browser.newPage();
    sess.page = page;

    const email = login.email || '';
    const password = login.password || '';

    try {
        // Navigate
        log('Opening ' + login.url);
        await page.goto(login.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for Cloudflare
        sess.status = 'captcha';
        log('Checking for Cloudflare...');
        for (let i = 0; i < 90; i++) {
            await sleep(2000);
            if (!sessions.has(id)) return;
            const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            if (!text.includes('Verify you are human') && !text.includes('Just a moment')) { log('Page loaded'); break; }
            if (i === 0) log('Cloudflare — solve manually in the browser');
            if (i % 10 === 0 && i > 0) log('Waiting... (' + (i*2) + 's)');
        }

        sess.status = 'running';
        await sleep(2000);

        // Click LOG IN
        log('Looking for login...');
        await page.evaluate(() => {
            for (const s of document.querySelectorAll('span[type="button"]')) if (s.textContent.trim().toUpperCase() === 'LOG IN') { s.click(); return; }
            const l = document.querySelector('a[href*="/login"]'); if (l) l.click();
        });
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await sleep(2000);

        // Fill
        const ef = await page.$('input[type="email"], input[name="username"], input#email-input-field');
        const pf = await page.$('input[type="password"]');
        if (ef && pf) {
            log('Filling credentials...');
            await ef.click({ clickCount: 3 }); await ef.type(email, { delay: 40 + Math.random() * 40 });
            await sleep(300);
            await pf.click({ clickCount: 3 }); await pf.type(password, { delay: 40 + Math.random() * 40 });
            await sleep(500);

            log('Clicking login...');
            await page.evaluate(() => {
                const b = document.querySelector('button#btn-login, button[type="submit"]');
                if (b && !b.disabled) { b.click(); return; }
                for (const b of document.querySelectorAll('button')) { const t = b.textContent.trim().toLowerCase(); if ((t==='login'||t==='log in'||t==='sign in') && !b.disabled) { b.click(); return; } }
            });
            sess.status = 'captcha'; log('Login clicked — solve CAPTCHA if needed');
            try { await page.waitForNavigation({ timeout: 180000 }); log('Navigated'); } catch(e) { log('Timeout'); }
            await sleep(2000);
        } else { log('No login form — already logged in'); }

        // My Application
        sess.status = 'running';
        if (page.url().includes('/country/') || page.url().includes('/vac/')) {
            log('My Application...');
            await page.evaluate(() => { const b = document.querySelector('[data-testid="user-button"]'); if (b) (b.closest('button,a,div')||b).click(); });
            await sleep(1000);
            await page.evaluate(() => { const e = document.querySelector('#my-application'); if (e) { e.click(); return; } document.querySelectorAll('a').forEach(a => { if (a.textContent.trim().toLowerCase()==='my application') a.click(); }); });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}); await sleep(2000);
        }

        // Select
        if (page.url().includes('travel-groups')) {
            log('Select...'); await page.evaluate(() => { const b = document.querySelector('button[name="formGroupId"]'); if (b) { const f = b.closest('form'); if (f) { try { f.requestSubmit(b); return; } catch(e){} } b.click(); } });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}); await sleep(2000);
        }

        // Continue
        for (let s = 0; s < 6; s++) {
            if (page.url().includes('appointment-booking')) break;
            log('Continue ' + (s+1) + '...');
            await page.evaluate(() => { const a = document.querySelector('a#book-appointment-btn'); if (a&&a.href) { window.location.href=a.href; return; } document.querySelectorAll('a,button').forEach(e => { const t=e.textContent.trim().toLowerCase(); if (t==='continue'||t.includes('book appointment')) { if (e.href) window.location.href=e.href; else e.click(); } }); });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}); await sleep(2000);
        }

        if (page.url().includes('appointment-booking')) { log('REACHED BOOKING PAGE!'); sess.status = 'booking'; }
        else { log('Done — ' + page.url()); sess.status = 'done'; }

        log('Browser open. Close manually when done.');
        await new Promise(r => browser.on('disconnected', r));
    } catch(err) { log('Error: ' + err.message); sess.status = 'error'; }
    finally { try { await gl.stop(); } catch(e) {} sessions.delete(id); console.log(`[${id}] Session ended`); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toISOString(); }

app.listen(PORT, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║   VisaD Auto Login v4 — GoLogin               ║');
    console.log('  ║   http://localhost:' + PORT + '                       ║');
    console.log('  ║   Fresh profile per login, unique fingerprint ║');
    console.log('  ║   vault.visad.co.uk/aaa.html → Auto Login    ║');
    console.log('  ╚═══════════════════════════════════════════════╝');
    console.log('');
});
