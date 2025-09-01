import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import express from 'express';
import fetch from 'node-fetch';
import https from 'https';
import http from 'http';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;
axios.defaults.timeout = 30000;

// Allowed domains
const ALLOWED_DOMAINS = [
  'https://leleflix.store',
  'https://www.leleflix.store',
  'http://localhost:3000',
  'https://vixsrc.to',
  'http://127.0.0.1:3000'
];

// Daily visitors
const dailyVisitors = {
  date: new Date().toDateString(),
  visitors: new Map()
};

// Middleware sicurezza
app.use((req, res, next) => {
  const origin = req.headers.origin || req.headers.referer || '';
  if (origin && !ALLOWED_DOMAINS.some(domain => origin.startsWith(domain))) {
    console.warn(`🔒 Accesso negato da: ${origin}`);
    return res.status(403).json({ error: 'Accesso riservato' });
  }
  next();
});

// Middleware registrazione visitatori
app.use((req, res, next) => {
  if (req.path.endsWith('.ts')) return next();
  const realIp = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.connection.remoteAddress;
  const country = req.headers['cf-ipcountry'] || 'XX';
  if (!dailyVisitors.visitors.has(realIp)) {
    dailyVisitors.visitors.set(realIp, {
      count: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
      country: country,
      userAgent: req.headers['user-agent']
    });
  } else {
    const visitor = dailyVisitors.visitors.get(realIp);
    visitor.count++;
    visitor.lastSeen = new Date();
  }
  next();
});

// Visitors admin
app.get('/admin/visitors', (req, res) => {
  const today = new Date().toDateString();
  if (dailyVisitors.date !== today) {
    saveDailyReport();
    dailyVisitors.date = today;
    dailyVisitors.visitors = new Map();
  }
  const visitorsArray = Array.from(dailyVisitors.visitors.entries()).map(([ip, data]) => ({
    ip,
    ...data,
    firstSeen: data.firstSeen.toISOString(),
    lastSeen: data.lastSeen.toISOString()
  }));
  res.json({ date: dailyVisitors.date, totalVisitors: dailyVisitors.visitors.size, visitors: visitorsArray });
});

function saveDailyReport() {
  const report = {
    date: dailyVisitors.date,
    totalVisitors: dailyVisitors.visitors.size,
    visitors: Array.from(dailyVisitors.visitors.entries()).map(([ip, data]) => ({
      ip,
      ...data,
      firstSeen: data.firstSeen.toISOString(),
      lastSeen: data.lastSeen.toISOString()
    }))
  };
  const reportsDir = path.join(__dirname, 'visitor-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);
  const filename = path.join(reportsDir, `${dailyVisitors.date.replace(/\s+/g, '-')}.json`);
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
}

function loadExistingData() {
  const reportsDir = path.join(__dirname, 'visitor-reports');
  if (fs.existsSync(reportsDir)) {
    const today = new Date().toDateString();
    const files = fs.readdirSync(reportsDir);
    files.forEach(file => {
      if (file.includes(today.replace(/\s+/g, '-'))) {
        const data = JSON.parse(fs.readFileSync(path.join(reportsDir, file)));
        data.visitors.forEach(visitor => {
          dailyVisitors.visitors.set(visitor.ip, {
            count: visitor.count,
            firstSeen: new Date(visitor.firstSeen),
            lastSeen: new Date(visitor.lastSeen),
            country: visitor.country,
            userAgent: visitor.userAgent
          });
        });
      }
    });
  }
}
loadExistingData();
process.on('SIGINT', () => { saveDailyReport(); process.exit(); });

app.get('/admin/visitors/by-country', (req, res) => {
  const byCountry = {};
  dailyVisitors.visitors.forEach(visitor => {
    byCountry[visitor.country] = (byCountry[visitor.country] || 0) + 1;
  });
  res.json(byCountry);
});

app.use('/admin', (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth === 'mason00') return next();
  res.status(401).send('Accesso non autorizzato');
});

const MAX_RESTARTS = 5;
let restarts = 0;
function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`📱 Proxy Android attivo su http://0.0.0.0:${PORT}/stream`);
    restarts = 0;
  });
  server.on('error', (err) => {
    if (restarts < MAX_RESTARTS) {
      restarts++;
      console.log(`Riavvio tentativo ${restarts}/${MAX_RESTARTS}...`);
      setTimeout(startServer, 3000);
    }
  });
}
startServer();

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/', (req, res) => { res.send(`<h1>Proxy attivo</h1>`); });
app.options('*', (req, res) => { res.sendStatus(200); });

function getProxyUrl(originalUrl) {
  return `https://api.leleflix.store/stream?url=${encodeURIComponent(originalUrl)}`;
}

// Regex extractor
async function vixsrcPlaylist(tmdbId, seasonNumber, episodeNumber) {
  const targetUrl = seasonNumber !== undefined
    ? `https://vixsrc.to/tv/${tmdbId}/${seasonNumber}/${episodeNumber}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;

  const response = await axios.get(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vixsrc.to' }
  });
  if (response.status !== 200) throw new Error(`Richiesta fallita con status ${response.status}`);

  const text = response.data;
  const playlistData = new RegExp(
    "token': '(.+)',\\n[ ]+'expires': '(.+)',\\n.+\\n.+\\n.+url: '(.+)',\\n[ ]+}\\n[ ]+window.canPlayFHD = (false|true)"
  ).exec(text);

  if (!playlistData) throw new Error("Impossibile estrarre dati playlist");

  const token = playlistData[1];
  const expires = playlistData[2];
  const playlistUrl = new URL(playlistData[3]);
  const canPlayFHD = playlistData[4];
  const b = playlistUrl.searchParams.get("b");

  playlistUrl.searchParams.append("token", token);
  playlistUrl.searchParams.append("expires", expires);
  if (b !== null) playlistUrl.searchParams.append("b", b);
  if (canPlayFHD === "true") playlistUrl.searchParams.append("h", "1");

  return playlistUrl.toString();
}

// Proxy endpoints
app.get('/proxy/movie/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const playlistUrl = await vixsrcPlaylist(id);
    const proxyUrl = getProxyUrl(playlistUrl);
    res.json({ url: proxyUrl });
  } catch (err) {
    console.error("❌ Errore nel proxy film (regex mode):", err);
    res.status(500).json({ error: "Errore durante l'estrazione del film" });
  }
});

app.get('/proxy/series/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    const playlistUrl = await vixsrcPlaylist(id, season, episode);
    const proxyUrl = getProxyUrl(playlistUrl);
    res.json({ url: proxyUrl });
  } catch (err) {
    console.error("❌ Errore nel proxy serie (regex mode):", err);
    res.status(500).json({ error: "Errore durante l'estrazione dell'episodio" });
  }
});

// Stream proxy universale (m3u8/ts)
app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');
  const isM3U8 = targetUrl.includes('.m3u8') || targetUrl.includes('playlist') || targetUrl.includes('master');
  if (isM3U8) {
    try {
      const response = await fetch(targetUrl, {
        headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' }
      });
      let text = await response.text();
      const baseUrl = targetUrl.split('/').slice(0, -1).join('/');
      const rewritten = text
        .replace(/URI="([^"]+)"/g, (match, uri) => {
          const absoluteUrl = uri.startsWith('http') ? uri : uri.startsWith('/') ? `https://vixsrc.to${uri}` : `${baseUrl}/${uri}`;
          return `URI="https://api.leleflix.store/stream?url=${encodeURIComponent(absoluteUrl)}"`;
        })
        .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, (match, file) => {
          const abs = `${baseUrl}/${file}`;
          return `https://api.leleflix.store/stream?url=${encodeURIComponent(abs)}`;
        })
        .replace(/(https?:\/\/[^\s\n"]+)/g, match => `https://api.leleflix.store/stream?url=${encodeURIComponent(match)}`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewritten);
    } catch (err) {
      console.error('Errore fetch m3u8:', err);
      res.status(500).send('Errore proxy m3u8');
    }
  } else {
    try {
      const urlObj = new URL(targetUrl);
      const client = urlObj.protocol === 'https:' ? https : http;
      const proxyReq = client.get(targetUrl, {
        headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).send('Timeout del gateway'); });
      proxyReq.on('error', err => { res.status(500).send('Errore proxy media'); });
    } catch (err) {
      res.status(400).send('URL invalido');
    }
  }
});

// Global error handling
process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); process.exit(1); });
process.on('warning', (warning) => { console.warn('Node Warning:', warning.name, warning.message); });
