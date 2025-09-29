// android-proxy.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import puppeteer from 'puppeteer-core';
import express from 'express';
import fetch from 'node-fetch';
import https from 'https';
import http from 'http';
import axios from 'axios';

const app = express();
const PORT = 3000;

axios.defaults.timeout = 30000; // 15 secondi invece di 10


// Struttura per memorizzare gli utenti unici del giorno
const dailyVisitors = {
  date: new Date().toDateString(),
  visitors: new Map() // Key: IP, Value: { count, firstSeen, lastSeen, country }
};
// Aggiungi questo all'inizio del tuo file, dopo le import
const ALLOWED_DOMAINS = [
  'https://flixe-delta.vercel.app',
  'https://schumynet.github.io',
  'http://localhost:3000',
  'https://vixsrc.to',
  'http://127.0.0.1:3000'

];

// Middleware di sicurezza
app.use((req, res, next) => {
  const origin = req.headers.origin || req.headers.referer || '';
  
  // Blocco immediato per domini specifici
  if (BLOCKED_DOMAINS.some(domain => origin.includes(domain))) {
    return res.status(403).json({
      error: 'Accesso bloccato',
      message: 'Utilizza leleflix.store per accedere al servizio'
    });
  }
  
  // Controllo per domini autorizzati
  if (origin && !ALLOWED_DOMAINS.some(domain => origin.startsWith(domain))) {
    console.warn(`🔒 Accesso negato da: ${origin}`);
    return res.status(403).json({
      error: 'Accesso riservato',
      message: 'Questo proxy è disponibile solo su leleflix.store'
    });
  }
  
  next();
});

// Middleware per registrare visitatori (ignora richieste .ts)
app.use((req, res, next) => {
  if (req.path.endsWith('.ts')) return next(); // Salta per segmenti video
  
  const realIp = req.headers['cf-connecting-ip'] || 
                (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || 
                req.connection.remoteAddress;
  const country = req.headers['cf-ipcountry'] || 'XX';

  // Aggiorna o aggiungi il visitatore
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

// Endpoint per vedere le statistiche giornaliere
app.get('/admin/visitors', (req, res) => {
  // Controlla se è un nuovo giorno
  const today = new Date().toDateString();
  if (dailyVisitors.date !== today) {
    // Salva i dati del giorno precedente
    saveDailyReport();
    // Resetta per il nuovo giorno
    dailyVisitors.date = today;
    dailyVisitors.visitors = new Map();
  }

  // Prepara i dati per la visualizzazione
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

// Funzione per salvare il report giornaliero
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

// All'avvio del server, carica eventuali dati esistenti
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

// Avvia il sistema
loadExistingData();

// Salva i dati all'uscita
process.on('SIGINT', () => {
  saveDailyReport();
  process.exit();
});

// Aggiungi questa funzione per vedere i visitatori per paese
app.get('/admin/visitors/by-country', (req, res) => {
  const byCountry = {};
  dailyVisitors.visitors.forEach(visitor => {
    byCountry[visitor.country] = (byCountry[visitor.country] || 0) + 1;
  });
  res.json(byCountry);
});

// Per proteggere gli endpoint admin
app.use('/admin', (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth === 'mason00') {
    return next();
  }
  res.status(401).send('Accesso non autorizzato');
});

// Aggiungi questo all'inizio del file
const MAX_RESTARTS = 5;
let restarts = 0;

function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`📱 Proxy Android attivo su http://0.0.0.0:${PORT}/stream`);
    restarts = 0; // Reset del contatore dopo avvio riuscito
  });

// Migliora la gestione degli errori del server
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

// Avvia il server invece di app.listen diretto
startServer();
// ✅ Abilita CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/', (req, res) => {
  res.send(`
    <h1>Informazioni visitatore</h1>
    <p><strong>IP:</strong> ${req.visitorInfo.ip}</p>
    <p><strong>Paese:</strong> ${req.visitorInfo.countryName}</p>
    <p><strong>Browser:</strong> ${req.visitorInfo.userAgent}</p>
  `);
});

app.options('*', (req, res) => {
  res.sendStatus(200);
});

function getProxyUrl(originalUrl) {
  return `https://vixproxy-gu-wra.fly.dev//stream?url=${encodeURIComponent(originalUrl)}`;
}

const TMDB_API_KEY = '1e8c9083f94c62dd66fb2105cd7b613b'; // Inserisci qui la tua chiave TMDb

const vixCache = {
  movie: { data: null, lastFetch: 0 },
  tv: { data: null, lastFetch: 0 }
};

async function fetchVixDatabase(type) {
  // Cache di 1 giorno
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
    return vixCache[type].data || []; // Restituisci i dati in cache se disponibili
  }
}

// Aggiungi questo endpoint dopo gli altri endpoint /home/*
app.get('/home/available', async (req, res) => {
  try {
    // Effettua le richieste a VixSRC dal server (senza problemi CORS)
    const [moviesRes, tvRes] = await Promise.all([
      axios.get('https://vixsrc.to/api/list/movie?lang=it', {
        headers: {
          'Referer': 'https://vixsrc.to',
          'User-Agent': 'Mozilla/5.0'
        }
      }),
      axios.get('https://vixsrc.to/api/list/tv?lang=it', {
        headers: {
          'Referer': 'https://vixsrc.to',
          'User-Agent': 'Mozilla/5.0'
        }
      })
    ]);

    // Combina e formatta i risultati
    const availableContent = {
      movies: moviesRes.data || [],
      tv: tvRes.data || [],
      lastUpdated: new Date().toISOString()
    };

    res.json(availableContent);

  } catch (err) {
    console.error('❌ Errore nel caricamento contenuti disponibili:', err);
    res.status(500).json({ 
      error: 'Errore nel recupero dei contenuti disponibili',
      details: err.message 
    });
  }
});

app.get('/home/trending', async (req, res) => {
  try {
    // Leggi i database VixSRC
     // Carica dinamicamente i database VixSRC
    const [rawMovies, rawTV] = await Promise.all([
      fetchVixDatabase('movie'),
      fetchVixDatabase('tv')
    ]);

    const vixMovieIds = new Set(rawMovies.map(e => e.tmdb_id));
    const vixTVIds = new Set(rawTV.map(e => e.tmdb_id));

    // Prendi trending da TMDb
    const [moviesRes, tvRes] = await Promise.all([
      axios.get(`https://api.themoviedb.org/3/trending/movie/day?language=it-IT&api_key=${TMDB_API_KEY}`),
      axios.get(`https://api.themoviedb.org/3/trending/tv/day?language=it-IT&api_key=${TMDB_API_KEY}`)
    ]);

    // Filtra quelli presenti su VixSRC
    const movies = (moviesRes.data.results || []).filter(movie => vixMovieIds.has(movie.id));
    const tv = (tvRes.data.results || []).filter(show => vixTVIds.has(show.id));

    res.json({ movies, tv });

  } catch (err) {
    console.error('❌ Errore nel caricamento trending:', err);
    res.status(500).json({ error: 'Errore nel caricamento contenuti trending' });
  }
});


app.get('/proxy/series/:id/:season/:episode', async (req, res) => {
  // Estrai i parametri dall'URL
  const { id, season, episode } = req.params;
  let browser;
  let page;
  
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    page = await browser.newPage();
    
    // Aggiungi cleanup dei listener
    const cleanupListeners = () => {
      page.removeAllListeners('requestfinished');
      page.removeAllListeners('error');
      page.removeAllListeners('close');
    };

    const targetUrl = `https://vixsrc.to/tv/${id}/${season}/${episode}?lang=it`;
    console.log('🎬 Navigo a:', targetUrl);

    const playlistUrl = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanupListeners();
        reject('Timeout raggiunto');
      }, 10000);

      const onRequestFinished = (request) => {
        const url = request.url();
        
        if (url.includes('/playlist/') && url.includes('token=') && url.includes('h=1')) {
          console.log("🔍 Intercettato:", url);
          clearTimeout(timeout);
          cleanupListeners();
          resolve(url);
        }
      };

      page.on('requestfinished', onRequestFinished);
      
      page.on('error', (err) => {
        cleanupListeners();
        clearTimeout(timeout);
        reject(err);
      });

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    });

    await browser.close();
    const proxyUrl = getProxyUrl(playlistUrl);
    res.json({ url: proxyUrl });

  } catch (err) {
    console.error('❌ Errore nel proxy serie TV:', err);
    if (page) await page.close().catch(e => console.error('Error closing page:', e));
    if (browser) await browser.close().catch(e => console.error('Error closing browser:', e));
    res.status(500).json({ error: 'Errore durante l\'estrazione dell\'episodio' });
  }
});


// Estrazione del link .m3u8 principale da vixsrc
app.get('/proxy/movie/:id', async (req, res) => {
  const { id } = req.params;
  let browser;
  let page;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });

    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ Referer: 'https://vixsrc.to' });
    console.log('🎬 Navigo a:', `https://vixsrc.to/movie/${id}?lang=it`);
    // Funzione per pulire i listener
    const cleanupListeners = () => {
      if (page) {
        page.removeAllListeners('requestfinished');
        page.removeAllListeners('error');
        page.removeAllListeners('close');
      }
    };

    const playlistUrl = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanupListeners();
        reject('Timeout raggiunto');
      }, 8000); // Aumentato a 15 secondi per i film
      const onRequestFinished = (request) => {
        const url = request.url();
        if (url.includes('/playlist/') && url.includes('token=') && url.includes('h=1')) {
          clearTimeout(timeout);
          cleanupListeners();
          resolve(url);
        }
      };

      const onPageError = (err) => {
        clearTimeout(timeout);
        cleanupListeners();
        reject(err);
      };

      page.on('requestfinished', onRequestFinished);
      page.on('error', onPageError);

      try {
        await page.goto(`https://vixsrc.to/movie/${id}?lang=it`, {
          
          waitUntil: 'domcontentloaded',
          timeout: 8000
        });
      } catch (err) {
        clearTimeout(timeout);
        cleanupListeners();
        reject(err);
      }
    });

    // Chiudi la pagina e il browser
    await page.close().catch(e => console.error('Error closing page:', e));
    await browser.close().catch(e => console.error('Error closing browser:', e));

    // Rispondi con link proxy
    const proxyUrl = getProxyUrl(playlistUrl);
    res.json({ url: proxyUrl });

  } catch (err) {
    console.error("❌ Errore nel proxy film:", err);
    
    // Pulizia completa in caso di errore
    if (page) {
      await page.close().catch(e => console.error('Error closing page on error:', e));
    }
    if (browser) {
      await browser.close().catch(e => console.error('Error closing browser on error:', e));
    }
    
    res.status(500).json({ 
      error: 'Errore durante l\'estrazione del flusso',
      details: err.message 
    });
  }
});


// Aggiungi queste variabili globali
const activeStreams = new Map();
const PENDING_REQUESTS = new Map();


// Endpoint migliorato per lo stop
app.get('/proxy/stream/stop', (req, res) => {
    const { streamId } = req.query;
    
    if (!streamId) {
        return res.status(400).json({ error: 'Stream ID mancante' });
    }

    // Cerca tra le connessioni attive
    const activeStream = activeStreams.get(streamId);
    if (activeStream) {
        console.log(`🛑 Termino flusso attivo ${streamId}`);
        activeStream.destroy();
        activeStreams.delete(streamId);
        return res.json({ success: true });
    }

    // Cerca tra le richieste in pending
    const pendingRequest = PENDING_REQUESTS.get(streamId);
    if (pendingRequest) {
        console.log(`⏹ Annullo richiesta in pending ${streamId}`);
        pendingRequest.abort();
        PENDING_REQUESTS.delete(streamId);
        return res.json({ success: true });
    }

    res.status(404).json({ error: 'Flusso non trovato' });
});

// Modifica il gestore /proxy/stream
app.get('/proxy/stream', async (req, res) => {
const targetUrl = req.query.url;
  const streamId = req.query.streamId;

  if (!targetUrl || !streamId) {
    return res.status(400).send('Parametri mancanti');
  }

  const abortController = new AbortController();
  PENDING_REQUESTS.set(streamId, abortController);

  // Cleanup function
  const cleanup = () => {
    PENDING_REQUESTS.delete(streamId);
    res.removeAllListeners('close');
  };

  res.on('close', () => {
    if (!res.headersSent) {
      abortController.abort();
    }
    cleanup();
  });

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'Referer': 'https://vixsrc.to',
                'User-Agent': 'Mozilla/5.0'
            },
            signal: abortController.signal
        });

            cleanup();


        PENDING_REQUESTS.delete(streamId);

        if (targetUrl.includes('.m3u8')) {
           const isM3U8 = targetUrl.includes('.m3u8') || targetUrl.includes('playlist') || targetUrl.includes('master');

  if (isM3U8) {
    try {
       sendHeaders(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.send(rewritten);
      const response = await fetch(targetUrl, {
        headers: {
          'Referer': 'https://vixsrc.to',
          'User-Agent': 'Mozilla/5.0'
        }
      });

      let text = await response.text();
const baseUrl = targetUrl.split('/').slice(0, -1).join('/');

const rewritten = text
  // Riscrive gli URI AES come URI="..."
  .replace(/URI="([^"]+)"/g, (match, uri) => {
    const absoluteUrl = uri.startsWith('http')
      ? uri
      : uri.startsWith('/')
        ? `https://vixsrc.to${uri}`
        : `${baseUrl}/${uri}`;
    return `URI="https://vixproxy-gu-wra.fly.dev//stream?url=${encodeURIComponent(absoluteUrl)}"`;
  })
  // Riscrive i segmenti .ts, .key o .m3u8 (righe non commentate)
  .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, (match, file) => {
    const abs = `${baseUrl}/${file}`;
    return `https://vixproxy-gu-wra.fly.dev//stream?url=${encodeURIComponent(abs)}`;
  })
  // Riscrive URL assoluti
  .replace(/(https?:\/\/[^\s\n"]+)/g, match =>
    `https://vixproxy-gu-wra.fly.dev//stream?url=${encodeURIComponent(match)}`
  );


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
  headers: {
    'Referer': 'https://vixsrc.to',
    'User-Agent': 'Mozilla/5.0'
  },
  timeout: 30000
}, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('timeout', () => {
  proxyReq.destroy();
  console.error('Timeout nella richiesta a:', targetUrl);
  if (!res.headersSent) {
    res.status(504).send('Timeout del gateway');
  }
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
        } else {
            const connection = {
                stream: response.body,
                destroy: () => response.body.destroy()
            };
            activeStreams.set(streamId, connection);

            req.on('close', () => {
                if (!res.headersSent) {
                    connection.destroy();
                    activeStreams.delete(streamId);
                }
            });

            res.writeHead(response.status, response.headers);
            response.body.pipe(res);
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Errore proxy:', err);
            res.status(500).send('Errore durante il proxy');
        }
        PENDING_REQUESTS.delete(streamId);
    }
});


// Gestione errori globale
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Potresti voler riavviare il processo qui
  process.exit(1);
});


// Aggiungi monitoring degli eventi
process.on('warning', (warning) => {
  console.warn('Node Warning:', warning.name);
  console.warn(warning.message);
  console.warn(warning.stack);
  
  if (warning.name === 'MaxListenersExceededWarning') {
    // Logga quali emitter hanno troppi listener
    console.error('Emitter with too many listeners:', warning.emitter);
  }
});

// Proxy universale per .m3u8, .ts, audio, sottotitoli
app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  const isM3U8 = targetUrl.includes('.m3u8') || targetUrl.includes('playlist') || targetUrl.includes('master');

  if (isM3U8) {
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'Referer': 'https://vixsrc.to',
          'User-Agent': 'Mozilla/5.0'
        }
      });

      let text = await response.text();
const baseUrl = targetUrl.split('/').slice(0, -1).join('/');

const rewritten = text
  // Riscrive gli URI AES come URI="..."
  .replace(/URI="([^"]+)"/g, (match, uri) => {
    const absoluteUrl = uri.startsWith('http')
      ? uri
      : uri.startsWith('/')
        ? `https://vixsrc.to${uri}`
        : `${baseUrl}/${uri}`;
    return `URI="https://vixproxy-gu-wra.fly.dev//stream?url=${encodeURIComponent(absoluteUrl)}"`;
  })
  // Riscrive i segmenti .ts, .key o .m3u8 (righe non commentate)
  .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, (match, file) => {
    const abs = `${baseUrl}/${file}`;
    return `https://vixproxy-gu-wra.fly.dev//stream?url=${encodeURIComponent(abs)}`;
  })
  // Riscrive URL assoluti
  .replace(/(https?:\/\/[^\s\n"]+)/g, match =>
    `https://vixproxy-gu-wra.fly.dev//stream?url=${encodeURIComponent(match)}`
  );


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
  headers: {
    'Referer': 'https://vixsrc.to',
    'User-Agent': 'Mozilla/5.0'
  },
  timeout: 15000 // Aggiungi timeout esplicito
}, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('timeout', () => {
  proxyReq.destroy();
  console.error('Timeout nella richiesta a:', targetUrl);
  if (!res.headersSent) {
    res.status(504).send('Timeout del gateway');
  }
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

