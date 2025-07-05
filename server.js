import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware per gestire CORS
app.use((req, res, next) => {
  // Imposta l'header Access-Control-Allow-Origin con il dominio del tuo frontend
  // oppure '*' per permettere a tutti i domini (sconsigliato per produzione)
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Altri header CORS importanti
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Gestione delle richieste preflight OPTIONS
app.options('*', (req, res) => {
  res.sendStatus(200);
});

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
    res.json({ url: playlistUrl });

  } catch (err) {
    console.error("Errore nel proxy:", err);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Errore durante l\'estrazione del flusso' });
  }
});

app.listen(PORT, () => {
  console.log(`🎥 Proxy in ascolto`);
});