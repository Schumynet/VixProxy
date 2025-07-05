import express from 'express';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware CORS
app.use(cors());

// Endpoint di test
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Proxy per m3u8, ts, key, audio, subtitle
app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    console.error('❌ Nessun parametro ?url=');
    return res.status(400).send('Missing url param');
  }

  console.log('📥 Proxy richiesto per:', targetUrl);

  const isM3U8 = targetUrl.includes('.m3u8') || targetUrl.includes('playlist') || targetUrl.includes('master');

  if (isM3U8) {
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'Referer': 'https://vixsrc.to',
          'User-Agent': 'Mozilla/5.0'
        }
      });

      if (!response.ok) {
        console.error(`❌ Errore fetch ${targetUrl}:`, response.status);
        return res.status(response.status).send('Errore nel fetch del manifest');
      }

      const text = await response.text();
      const baseUrl = targetUrl.split('/').slice(0, -1).join('/');

      const rewritten = text
        // Riscrivi URI delle chiavi AES
        .replace(/URI="([^"]+)"/g, (match, uri) => {
          const absoluteUrl = uri.startsWith('http')
            ? uri
            : uri.startsWith('/')
              ? `https://vixsrc.to${uri}`
              : `${baseUrl}/${uri}`;
          return `URI="${getProxyUrl(absoluteUrl)}"`;
        })
        // Riscrivi file .ts, .key, .m3u8 relativi
        .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, match => {
          const abs = `${baseUrl}/${match}`;
          return getProxyUrl(abs);
        })
        // Riscrivi URL assoluti
        .replace(/(https?:\/\/[^\s\n"]+)/g, match =>
          getProxyUrl(match)
        );

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewritten);
    } catch (err) {
      console.error('❌ Errore proxy m3u8:', err);
      res.status(500).send('Errore proxy m3u8');
    }

  } else {
    // Segmenti .ts / audio / subtitles / enc.key
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
        console.error('❌ Errore durante il proxy di segmenti:', err);
        res.status(500).send('Errore segmenti');
      });

    } catch (err) {
      console.error('❌ URL invalido:', err);
      res.status(400).send('URL invalido');
    }
  }
});

function getProxyUrl(originalUrl) {
  const proxyHost = 'https://vixproxy.onrender.com';
  return `${proxyHost}/stream?url=${encodeURIComponent(originalUrl)}`;
}

app.listen(PORT, () => {
  console.log(`🚀 Server avviato su porta ${PORT}`);
});
