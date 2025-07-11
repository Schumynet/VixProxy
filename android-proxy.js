// android-proxy.js
import express from 'express';
import fetch from 'node-fetch';
import https from 'https';
import http from 'http';

const app = express();
const PORT = 3000;

// ✅ Abilita CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.options('*', (req, res) => {
  res.sendStatus(200);
});

function getProxyUrl(originalUrl) {
  return `http://192.168.102.93:3000/stream?url=${encodeURIComponent(originalUrl)}`;
}

const TMDB_API_KEY = '1e8c9083f94c62dd66fb2105cd7b613b'; // Inserisci qui la tua chiave TMDb

app.get('/home/trending', async (req, res) => {
  try {
    // Leggi i database VixSRC
    const rawMovies = JSON.parse(fs.readFileSync(path.join(__dirname, 'vix-movies-ids.json')));
    const rawTV = JSON.parse(fs.readFileSync(path.join(__dirname, 'vix-tv-ids.json')));
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
  const { id, season, episode } = req.params;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ Referer: 'https://vixsrc.to' });

    const targetUrl = `https://vixsrc.to/tv/${id}/${season}/${episode}?lang=it`;
    console.log('🎬 Navigo a:', targetUrl);

    const playlistUrl = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => reject('Timeout raggiunto'), 10000);

      page.on('requestfinished', request => {
        const url = request.url();
        console.log("🔍 Intercettato:", url);
        if (url.includes('/playlist/') && url.includes('token=') && url.includes('h=1')) {
          clearTimeout(timeout);
          resolve(url);
        }
      });

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    });

    await browser.close();

    res.json({ url: playlistUrl });

  } catch (err) {
    console.error('❌ Errore nel proxy serie TV:', err);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Errore durante l\'estrazione dell\'episodio' });
  }
});


// Estrazione del link .m3u8 principale da vixsrc
app.get('/proxy/movie/:id', async (req, res) => {
  const { id } = req.params;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ Referer: 'https://vixsrc.to' });

    const playlistUrl = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => reject('Timeout raggiunto'), 10000);

      page.on('requestfinished', request => {
        const url = request.url();
        if (
          url.includes('/playlist/') &&
          url.includes('token=') &&
          url.includes('h=1')
        ) {
          clearTimeout(timeout);
          resolve(url);
        }
      });

      await page.goto(`https://vixsrc.to/movie/${id}?lang=it`, {
        waitUntil: 'domcontentloaded'
      });
    });

    await browser.close();

    // Rispondi con link proxy
    res.json({ url: playlistUrl });


  } catch (err) {
    console.error("Errore nel proxy:", err);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Errore durante l\'estrazione del flusso' });
  }
});

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
        .replace(/URI="([^"]+)"/g, (match, uri) => {
          const absoluteUrl = uri.startsWith('http') ? uri : uri.startsWith('/') ? `https://vixsrc.to${uri}` : `${baseUrl}/${uri}`;
          return `URI="${getProxyUrl(absoluteUrl)}"`;
        })
        .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, (match, file) => {
          const abs = `${baseUrl}/${file}`;
          return getProxyUrl(abs);
        })
        .replace(/(https?:\/\/[^\s\n"]+)/g, match => getProxyUrl(match));

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
        }
      }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📱 Proxy Android attivo su http://0.0.0.0:${PORT}/stream`);
});
