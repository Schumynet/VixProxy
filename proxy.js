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

axios.defaults.timeout = 30000; // timeout 30s

// === Sicurezza: domini autorizzati ===
const ALLOWED_DOMAINS = [
  'https://leleflix.store',
  'https://www.leleflix.store',
  'http://localhost:3000',
  'https://vixsrc.to',
  'http://127.0.0.1:3000'
];

app.use((req, res, next) => {
  const origin = req.headers.origin || req.headers.referer || '';
  if (origin && !ALLOWED_DOMAINS.some(domain => origin.startsWith(domain))) {
    console.warn(`🔒 Accesso negato da: ${origin}`);
    return res.status(403).json({
      error: 'Accesso riservato',
      message: 'Questo proxy è disponibile solo su leleflix.store'
    });
  }
  next();
});

// === Statistiche visitatori ===
const dailyVisitors = {
  date: new Date().toDateString(),
  visitors: new Map()
};
// === Logging contenuti visualizzati ===
const dailyContentViews = {
  date: new Date().toDateString(),
  views: new Map() // IP -> array di contenuti visualizzati
};

// Cache per i titoli TMDB per evitare richieste duplicate
const tmdbTitleCache = new Map();

async function getTMDBTitle(tmdbId, contentType, season = null, episode = null) {
  const cacheKey = contentType === 'movie' 
    ? `movie-${tmdbId}` 
    : `tv-${tmdbId}-${season}-${episode}`;
    
  if (tmdbTitleCache.has(cacheKey)) {
    return tmdbTitleCache.get(cacheKey);
  }
  
  try {
    if (contentType === 'movie') {
      const response = await axios.get(
        `https://api.themoviedb.org/3/movie/${tmdbId}?language=it-IT&api_key=${TMDB_API_KEY}`
      );
      const title = response.data.title || response.data.original_title || 'Titolo sconosciuto';
      tmdbTitleCache.set(cacheKey, title);
      return title;
    } else {
      // Per le serie TV, prima ottieni il titolo della serie
      const [seriesResponse, episodeResponse] = await Promise.all([
        axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}?language=it-IT&api_key=${TMDB_API_KEY}`),
        axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?language=it-IT&api_key=${TMDB_API_KEY}`)
      ]);
      
      const seriesTitle = seriesResponse.data.name || seriesResponse.data.original_name || 'Serie sconosciuta';
      const episodeTitle = episodeResponse.data.name || `Episodio ${episode}`;
      const fullTitle = `${seriesTitle} - S${season}E${episode}: ${episodeTitle}`;
      
      tmdbTitleCache.set(cacheKey, fullTitle);
      return fullTitle;
    }
  } catch (err) {
    console.error(`❌ Errore recupero titolo TMDB ${tmdbId}:`, err.message);
    const fallbackTitle = contentType === 'movie' 
      ? `Film ${tmdbId}` 
      : `Serie ${tmdbId} S${season}E${episode}`;
    tmdbTitleCache.set(cacheKey, fallbackTitle);
    return fallbackTitle;
  }
}

async function logContentView(ip, contentType, tmdbId, season = null, episode = null) {
  const today = new Date().toDateString();
  
  // Reset giornaliero
  if (dailyContentViews.date !== today) {
    saveContentViewsReport();
    dailyContentViews.date = today;
    dailyContentViews.views = new Map();
  }
  
  if (!dailyContentViews.views.has(ip)) {
    dailyContentViews.views.set(ip, []);
  }
  
  // Recupera il titolo da TMDB
  const title = await getTMDBTitle(tmdbId, contentType, season, episode);
  
  const viewData = {
    timestamp: new Date().toISOString(),
    type: contentType, // 'movie' o 'series'
    tmdbId: parseInt(tmdbId),
    title: title,
    season: season ? parseInt(season) : null,
    episode: episode ? parseInt(episode) : null
  };
  
  dailyContentViews.views.get(ip).push(viewData);
  
  console.log(`📺 [${ip}] Visualizza: ${title}`);
}

function saveContentViewsReport() {
  if (dailyContentViews.views.size === 0) return;
  
  const report = {
    date: dailyContentViews.date,
    totalViews: Array.from(dailyContentViews.views.values()).reduce((acc, views) => acc + views.length, 0),
    uniqueViewers: dailyContentViews.views.size,
    viewsByIP: Array.from(dailyContentViews.views.entries()).map(([ip, views]) => ({
      ip,
      totalViews: views.length,
      content: views
    }))
  };
  
  const reportsDir = path.join(__dirname, 'content-reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
  }
  
  const filename = path.join(reportsDir, `content-${dailyContentViews.date.replace(/\s+/g, '-')}.json`);
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(`💾 Report contenuti salvato: ${filename}`);
}

function loadExistingContentData() {
  const reportsDir = path.join(__dirname, 'content-reports');
  if (fs.existsSync(reportsDir)) {
    const today = new Date().toDateString();
    const files = fs.readdirSync(reportsDir);
    files.forEach(file => {
      if (file.includes(`content-${today.replace(/\s+/g, '-')}`)) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(reportsDir, file)));
          data.viewsByIP.forEach(viewer => {
            dailyContentViews.views.set(viewer.ip, viewer.content);
          });
          console.log(`📊 Caricati dati contenuti esistenti per oggi`);
        } catch (err) {
          console.error('Errore caricamento dati contenuti:', err);
        }
      }
    });
  }
}

// Caricare i dati esistenti all'avvio
loadExistingContentData();

// === Endpoint per visualizzare le statistiche contenuti ===

// Endpoint per vedere tutti i contenuti visualizzati oggi
app.get('/admin/content-views', (req, res) => {
  const today = new Date().toDateString();
  if (dailyContentViews.date !== today) {
    saveContentViewsReport();
    dailyContentViews.date = today;
    dailyContentViews.views = new Map();
  }
  
  const viewsArray = Array.from(dailyContentViews.views.entries()).map(([ip, views]) => ({
    ip,
    totalViews: views.length,
    content: views
  }));
  
  res.json({
    date: dailyContentViews.date,
    totalViews: viewsArray.reduce((acc, viewer) => acc + viewer.totalViews, 0),
    uniqueViewers: dailyContentViews.views.size,
    viewsByIP: viewsArray
  });
});

// Endpoint per vedere i contenuti più visti
app.get('/admin/content-stats', async (req, res) => {
  const contentStats = new Map();
  
  dailyContentViews.views.forEach(views => {
    views.forEach(view => {
      const key = view.type === 'movie' 
        ? `movie-${view.tmdbId}`
        : `series-${view.tmdbId}`;
      
      if (!contentStats.has(key)) {
        contentStats.set(key, {
          type: view.type,
          tmdbId: view.tmdbId,
          title: view.title,
          season: view.season,
          episode: view.episode,
          viewCount: 0,
          uniqueViewers: new Set(),
          episodes: view.type === 'series' ? new Set() : null
        });
      }
      
      const stat = contentStats.get(key);
      stat.viewCount++;
      
      // Per le serie TV, traccia anche gli episodi unici
      if (view.type === 'series') {
        stat.episodes.add(`S${view.season}E${view.episode}`);
        // Aggiorna il titolo con quello più recente (per avere il titolo della serie)
        if (view.title && view.title.includes(' - S')) {
          stat.title = view.title.split(' - S')[0];
        }
      }
    });
  });
  
  const statsArray = Array.from(contentStats.values())
    .map(stat => ({
      ...stat,
      episodes: stat.episodes ? Array.from(stat.episodes).sort() : null,
      uniqueViewers: undefined // Rimuoviamo il Set dalla risposta JSON
    }))
    .sort((a, b) => b.viewCount - a.viewCount);
  
  res.json({
    date: dailyContentViews.date,
    mostWatched: statsArray
  });
});

// === Modificare gli endpoint proxy per aggiungere il logging ===

app.use((req, res, next) => {
  if (req.path.endsWith('.ts')) return next();
  const realIp = req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
    req.connection.remoteAddress;
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
  res.json({
    date: dailyVisitors.date,
    totalVisitors: dailyVisitors.visitors.size,
    visitors: visitorsArray
  });
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
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
  }
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

process.on('SIGINT', () => {
  console.log('\n🛑 Arresto del server...');
  saveDailyReport();
  saveContentViewsReport();
  process.exit();
});

app.get('/admin/visitors/by-country', (req, res) => {
  const byCountry = {};
  dailyVisitors.visitors.forEach(visitor => {
    byCountry[visitor.country] = (byCountry[visitor.country] || 0) + 1;
  });
  res.json(byCountry);
});

// Protezione admin
app.use('/admin', (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth === 'mason00') {
    return next();
  }
  res.status(401).send('Accesso non autorizzato');
});

// === Gestione server ===
const MAX_RESTARTS = 5;
let restarts = 0;

function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`📱 Proxy Android attivo su http://0.0.0.0:${PORT}/stream`);
    restarts = 0;
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Porta ${PORT} già in uso`);
    } else if (err.code === 'ECONNRESET') {
      console.warn('Connessione resettata dal client');
    } else {
      console.error('Errore del server:', err);
    }
    if (restarts < MAX_RESTARTS) {
      restarts++;
      console.log(`Riavvio tentativo ${restarts}/${MAX_RESTARTS}...`);
      setTimeout(startServer, 3000);
    }
  });
}
startServer();

// === CORS ===
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/', (req, res) => {
  res.send(`<h1>Proxy attivo</h1>`);
});

app.options('*', (req, res) => {
  res.sendStatus(200);
});

function getProxyUrl(originalUrl) {
  return `https://api.leleflix.store/stream?url=${encodeURIComponent(originalUrl)}`;
}

// === VixSRC Database ===
const TMDB_API_KEY = '1e8c9083f94c62dd66fb2105cd7b613b';
const vixCache = {
  movie: { data: null, lastFetch: 0 },
  tv: { data: null, lastFetch: 0 }
};

async function fetchVixDatabase(type) {
  if (vixCache[type].data && Date.now() - vixCache[type].lastFetch < 86400000) {
    return vixCache[type].data;
  }
  try {
    const response = await axios.get(`https://vixsrc.to/api/list/${type}?lang=it`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://vixsrc.to'
      }
    });
    vixCache[type] = {
      data: response.data || [],
      lastFetch: Date.now()
    };
    return vixCache[type].data;
  } catch (err) {
    console.error(`❌ Errore nel caricamento database VixSRC (${type}):`, err);
    return vixCache[type].data || [];
  }
}

// Endpoint home
app.get('/home/available', async (req, res) => {
  try {
    const [moviesRes, tvRes] = await Promise.all([
      axios.get('https://vixsrc.to/api/list/movie?lang=it', {
        headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' }
      }),
      axios.get('https://vixsrc.to/api/list/tv?lang=it', {
        headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' }
      })
    ]);
    res.json({
      movies: moviesRes.data || [],
      tv: tvRes.data || [],
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Errore /home/available:', err);
    res.status(500).json({ error: 'Errore contenuti disponibili' });
  }
});

app.get('/home/trending', async (req, res) => {
  try {
    const [rawMovies, rawTV] = await Promise.all([
      fetchVixDatabase('movie'),
      fetchVixDatabase('tv')
    ]);
    const vixMovieIds = new Set(rawMovies.map(e => e.tmdb_id));
    const vixTVIds = new Set(rawTV.map(e => e.tmdb_id));
    const [moviesRes, tvRes] = await Promise.all([
      axios.get(`https://api.themoviedb.org/3/trending/movie/day?language=it-IT&api_key=${TMDB_API_KEY}`),
      axios.get(`https://api.themoviedb.org/3/trending/tv/day?language=it-IT&api_key=${TMDB_API_KEY}`)
    ]);
    const movies = (moviesRes.data.results || []).filter(m => vixMovieIds.has(m.id));
    const tv = (tvRes.data.results || []).filter(s => vixTVIds.has(s.id));
    res.json({ movies, tv });
  } catch (err) {
    console.error('❌ Errore /home/trending:', err);
    res.status(500).json({ error: 'Errore trending' });
  }
});

// === Funzione regex per playlist ===
async function vixsrcPlaylist(tmdbId, seasonNumber, episodeNumber) {
  const targetUrl = seasonNumber !== undefined
    ? `https://vixsrc.to/tv/${tmdbId}/${seasonNumber}/${episodeNumber}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;

  const response = await axios.get(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vixsrc.to' }
  });
  if (response.status !== 200) throw new Error(`Status ${response.status}`);
  const text = response.data;
  const playlistData = new RegExp(
    "token': '(.+)',\\n[ ]+'expires': '(.+)',\\n.+\\n.+\\n.+url: '(.+)',\\n[ ]+}\\n[ ]+window.canPlayFHD = (false|true)"
  ).exec(text);
  if (!playlistData) throw new Error("Regex match fallito");
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

app.get('/proxy/movie/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const playlistUrl = await vixsrcPlaylist(id);
    
    // Log della visualizzazione (in background per non rallentare la risposta)
    const realIp = req.headers['cf-connecting-ip'] ||
      (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
      req.connection.remoteAddress;
    
    // Non aspettiamo il completamento del log per non rallentare lo stream
    logContentView(realIp, 'movie', id).catch(err => 
      console.error('Errore logging movie:', err)
    );
    
    res.json({ url: getProxyUrl(playlistUrl) });
  } catch (err) {
    console.error("❌ Errore proxy movie:", err);
    res.status(500).json({ error: "Errore estrazione film" });
  }
});

// SOSTITUIRE l'endpoint /proxy/series/:id/:season/:episode con questo:
app.get('/proxy/series/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    const playlistUrl = await vixsrcPlaylist(id, season, episode);
    
    // Log della visualizzazione (in background per non rallentare la risposta)
    const realIp = req.headers['cf-connecting-ip'] ||
      (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
      req.connection.remoteAddress;
    
    // Non aspettiamo il completamento del log per non rallentare lo stream
    logContentView(realIp, 'series', id, season, episode).catch(err => 
      console.error('Errore logging series:', err)
    );
    
    res.json({ url: getProxyUrl(playlistUrl) });
  } catch (err) {
    console.error("❌ Errore proxy series:", err);
    res.status(500).json({ error: "Errore estrazione episodio" });
  }
});

// === Gestione stream ===
const activeStreams = new Map();
const PENDING_REQUESTS = new Map();

app.get('/proxy/stream/stop', (req, res) => {
  const { streamId } = req.query;
  if (!streamId) return res.status(400).json({ error: 'Stream ID mancante' });
  const activeStream = activeStreams.get(streamId);
  if (activeStream) {
    console.log(`🛑 Stop flusso ${streamId}`);
    activeStream.destroy();
    activeStreams.delete(streamId);
    return res.json({ success: true });
  }
  const pendingRequest = PENDING_REQUESTS.get(streamId);
  if (pendingRequest) {
    console.log(`⏹ Cancello pending ${streamId}`);
    pendingRequest.abort();
    PENDING_REQUESTS.delete(streamId);
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Flusso non trovato' });
});

app.get('/proxy/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const streamId = req.query.streamId;
  if (!targetUrl || !streamId) return res.status(400).send('Parametri mancanti');
  const abortController = new AbortController();
  PENDING_REQUESTS.set(streamId, abortController);
  const cleanup = () => {
    PENDING_REQUESTS.delete(streamId);
    res.removeAllListeners('close');
  };
  res.on('close', () => {
    if (!res.headersSent) abortController.abort();
    cleanup();
  });
  try {
    const response = await fetch(targetUrl, {
      headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' },
      signal: abortController.signal
    });
    cleanup();
    if (targetUrl.includes('.m3u8')) {
      let text = await response.text();
      const baseUrl = targetUrl.split('/').slice(0, -1).join('/');
      const rewritten = text
        .replace(/URI="([^"]+)"/g, (m, uri) => {
          const absoluteUrl = uri.startsWith('http') ? uri : uri.startsWith('/')
            ? `https://vixsrc.to${uri}` : `${baseUrl}/${uri}`;
          return `URI="${getProxyUrl(absoluteUrl)}"`;
        })
        .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, (m, file) =>
          `${getProxyUrl(`${baseUrl}/${file}`)}`
        )
        .replace(/(https?:\/\/[^\s\n"]+)/g, m => getProxyUrl(m));
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewritten);
    } else {
      const urlObj = new URL(targetUrl);
      const client = urlObj.protocol === 'https:' ? https : http;
      const proxyReq = client.get(targetUrl, {
        headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' },
        timeout: 30000
      }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).send('Timeout');
      });
      proxyReq.on('error', err => {
        console.error('Errore stream:', err);
        res.status(500).send('Errore proxy media');
      });
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Errore proxy:', err);
      res.status(500).send('Errore durante il proxy');
    }
    PENDING_REQUESTS.delete(streamId);
  }
});

// === Proxy universale ===
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
        .replace(/URI="([^"]+)"/g, (m, uri) => {
          const absoluteUrl = uri.startsWith('http') ? uri : uri.startsWith('/')
            ? `https://vixsrc.to${uri}` : `${baseUrl}/${uri}`;
          return `URI="${getProxyUrl(absoluteUrl)}"`;
        })
        .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, (m, file) =>
          `${getProxyUrl(`${baseUrl}/${file}`)}`
        )
        .replace(/(https?:\/\/[^\s\n"]+)/g, m => getProxyUrl(m));
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
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).send('Timeout del gateway');
      });
      proxyReq.on('error', err => {
        console.error('Errore segmenti:', err);
        res.status(500).send('Errore proxy media');
      });
    } catch (err) {
      console.error('URL invalido:', err);
      res.status(400).send('URL invalido');
    }
  }
});

// === Error handling globale ===
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});
process.on('warning', (warning) => {
  console.warn('Node Warning:', warning.name, warning.message);
});
