/**
 * VisaD Auto Login v5 — puppeteer-real-browser
 * Uses your REAL Chrome — no automation flags, passes Cloudflare.
 * Each login opens a fresh profile.
 */

import { connect } from 'puppeteer-real-browser';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size, type: 'real-browser', local: true }));

app.post('/start', async (req, res) => {
    if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: 'Max sessions' });
    const { login } = req.body;
    if (!login || !login.url) return res.status(400).json({ error: 'URL required' });
    const id = genId();
    sessions.set(id, { id, browser: null, page: null, status: 'starting', login, log: [] });
    res.json({ sessionId: id, status: 'starting' });
    runAutoLogin(id, login).catch(err => {
        console.error(`[${id}] Fatal:`, err.message);
        const s = sessions.get(id); if (s) { s.status = 'error'; s.log.push({ time: now(), msg: err.message }); }
    });
});

app.get('/status/:id', (req, res) => { const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' }); res.json({ sessionId: s.id, status: s.status, log: s.log.slice(-20) }); });
app.post('/stop/:id', async (req, res) => { const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' }); try { if (s.browser) await s.browser.close(); } catch(e) {} sessions.delete(s.id); cleanup(path.join(PROFILES_DIR, s.id)); res.json({ status: 'stopped' }); });
app.get('/screenshot/:id', async (req, res) => { const s = sessions.get(req.params.id); if (!s || !s.page) return res.status(404).json({ error: 'No page' }); try { const img = await s.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75 }); res.json({ image: 'data:image/jpeg;base64,' + img }); } catch(e) { res.status(500).json({ error: 'Failed' }); } });
app.get('/sessions', (req, res) => { const list = []; for (const [, s] of sessions) list.push({ id: s.id, status: s.status, login: { profile_name: s.login.profile_name, url: s.login.url }, log: s.log.slice(-5) }); res.json({ sessions: list }); });

// ─── Auto Login ──────────────────────────────────────────────
async function runAutoLogin(id, login) {
    const sess = sessions.get(id);
    const log = (msg) => { console.log(`[${id}] ${msg}`); if (sess) sess.log.push({ time: now(), msg }); };

    const profileDir = path.join(PROFILES_DIR, id);

    log('Launching real Chrome (Cloudflare-proof)...');
    const { browser, page } = await connect({
        headless: false,
        turnstile: true,       // Auto-solve Cloudflare Turnstile
        args: [
            '--window-size=1366,900',
            '--no-first-run',
            '--no-default-browser-check'
        ],
        customConfig: {
            userDataDir: profileDir
        }
    });

    sess.browser = browser;
    sess.page = page;

    const email = login.email || '';
    const password = login.password || '';

    try {
        // Navigate
        log('Opening ' + login.url);
        await page.goto(login.url, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // Cloudflare handled automatically by turnstile:true
        log('Waiting for page (Turnstile auto-solved)...');
        sess.status = 'captcha';

        for (let i = 0; i < 60; i++) {
            await sleep(2000);
            if (!sessions.has(id)) return;
            const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            const u = page.url();
            if (!text.includes('Verify you are human') && !text.includes('Just a moment') && (u.includes('tlscontact.com') || u.includes('vfsglobal.com'))) {
                log('Page loaded — Cloudflare passed!');
                break;
            }
            if (i === 0) log('Cloudflare solving...');
            if (i % 10 === 0 && i > 0) log('Still waiting... (' + (i*2) + 's)');
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

        // Fill credentials
        const ef = await page.$('input[type="email"], input[name="username"], input#email-input-field');
        const pf = await page.$('input[type="password"]');
        if (ef && pf) {
            log('Filling credentials...');
            await ef.click({ clickCount: 3 });
            await ef.type(email, { delay: 40 + Math.random() * 40 });
            await sleep(300);
            await pf.click({ clickCount: 3 });
            await pf.type(password, { delay: 40 + Math.random() * 40 });
            await sleep(500);

            log('Clicking login...');
            await page.evaluate(() => {
                const b = document.querySelector('button#btn-login, button[type="submit"]');
                if (b && !b.disabled) { b.click(); return; }
                for (const b of document.querySelectorAll('button')) {
                    const t = b.textContent.trim().toLowerCase();
                    if ((t==='login'||t==='log in'||t==='sign in') && !b.disabled) { b.click(); return; }
                }
            });
            sess.status = 'captcha';
            log('Login clicked — solve reCAPTCHA if needed');
            try { await page.waitForNavigation({ timeout: 180000 }); log('Navigated'); } catch(e) { log('Timeout'); }
            await sleep(2000);
        } else {
            log('No login form — already logged in');
        }

        // My Application
        sess.status = 'running';
        if (page.url().includes('/country/') || page.url().includes('/vac/')) {
            log('My Application...');
            await page.evaluate(() => { const b = document.querySelector('[data-testid="user-button"]'); if (b) (b.closest('button,a,div')||b).click(); });
            await sleep(1000);
            await page.evaluate(() => { const e = document.querySelector('#my-application'); if (e) { e.click(); return; } document.querySelectorAll('a').forEach(a => { if (a.textContent.trim().toLowerCase()==='my application') a.click(); }); });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        // Select
        if (page.url().includes('travel-groups')) {
            log('Select...');
            await page.evaluate(() => { const b = document.querySelector('button[name="formGroupId"]'); if (b) { const f = b.closest('form'); if (f) { try { f.requestSubmit(b); return; } catch(e){} } b.click(); } });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        // Continue
        for (let s = 0; s < 6; s++) {
            if (page.url().includes('appointment-booking')) break;
            log('Continue ' + (s+1) + '...');
            await page.evaluate(() => { const a = document.querySelector('a#book-appointment-btn'); if (a&&a.href) { window.location.href=a.href; return; } document.querySelectorAll('a,button').forEach(e => { const t=e.textContent.trim().toLowerCase(); if (t==='continue'||t.includes('book appointment')) { if (e.href) window.location.href=e.href; else e.click(); } }); });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await sleep(2000);
        }

        if (page.url().includes('appointment-booking')) { log('REACHED BOOKING PAGE!'); sess.status = 'booking'; }
        else { log('Done — ' + page.url()); sess.status = 'done'; }

        log('Browser open. Close manually when done.');
        await new Promise(r => browser.on('disconnected', r));

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toISOString(); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {} }

app.listen(PORT, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════════╗');
    console.log('  ║   VisaD Auto Login v5 — Real Browser              ║');
    console.log('  ║   http://localhost:' + PORT + '                           ║');
    console.log('  ║                                                   ║');
    console.log('  ║   Uses YOUR real Chrome — zero automation flags   ║');
    console.log('  ║   Cloudflare Turnstile auto-solved                ║');
    console.log('  ║   Fresh profile per session                       ║');
    console.log('  ║                                                   ║');
    console.log('  ║   vault.visad.co.uk/aaa.html → Auto Login        ║');
    console.log('  ╚═══════════════════════════════════════════════════╝');
    console.log('');
});
