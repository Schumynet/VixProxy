import express from 'express';
import puppeteer from 'puppeteer';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import fetch from 'node-fetch';

const app = express();
const PORT = 3000;

// CORS middleware globale
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // oppure metti solo 'http://localhost:5500' per sicurezza
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.options('*', (req, res) => {
  res.sendStatus(200);
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

    const targetUrl = `https://vixsrc.to/serie/${id}/season/${season}/episode/${episode}?lang=it`;
    console.log('🎬 Navigo a:', targetUrl);

    const playlistUrl = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => reject('Timeout raggiunto'), 10000);

      page.on('requestfinished', request => {
        const url = request.url();
        if (url.includes('/playlist/') && url.includes('token=') && url.includes('h=1')) {
          clearTimeout(timeout);
          resolve(url);
        }
      });

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    });

    await browser.close();

    const proxyUrl = getProxyUrl(playlistUrl);
    res.json({ url: proxyUrl });

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
    const proxyUrl = `https://vixproxy.fly.dev/stream?url=${encodeURIComponent(playlistUrl)}`;
    res.json({ url: proxyUrl });

  } catch (err) {
    console.error("Errore nel proxy:", err);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Errore durante l\'estrazione del flusso' });
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
    return `URI="https://vixproxy.fly.dev/stream?url=${encodeURIComponent(absoluteUrl)}"`;
  })
  // Riscrive i segmenti .ts, .key o .m3u8 (righe non commentate)
  .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, (match, file) => {
    const abs = `${baseUrl}/${file}`;
    return `https://vixproxy.fly.dev/stream?url=${encodeURIComponent(abs)}`;
  })
  // Riscrive URL assoluti
  .replace(/(https?:\/\/[^\s\n"]+)/g, match =>
    `https://vixproxy.fly.dev/stream?url=${encodeURIComponent(match)}`
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
  console.log(`🚀 Server avviato su 0.0.0.0:${PORT}`);
});

