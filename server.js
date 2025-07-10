import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import express from 'express';
import puppeteer from 'puppeteer';
import https from 'https';
import http from 'http';
import fetch from 'node-fetch';
import axios from 'axios';

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

app.get('/proxy/movie/:id', async (req, res) => {
  const { id } = req.params;
  let browser;

  try {
    // 1. Configurazione avanzata di Puppeteer
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });

    const page = await browser.newPage();
    
    // 2. Imposta headers più realistici
    await page.setExtraHTTPHeaders({
      'Referer': 'https://vixsrc.to',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    // 3. Simula comportamento umano
    await page.setViewport({ width: 1366, height: 768 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const targetUrl = `https://vixsrc.to/movie/${id}?lang=it`;
    console.log('Navigating to:', targetUrl);

    // 4. Aggiungi ritardi casuali e gestione più robusta
    const playlistUrl = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => reject('Timeout reached'), 20000);

      page.on('requestfinished', async (request) => {
        const url = request.url();
        if (url.includes('/playlist/') && url.includes('token=') && url.includes('h=1')) {
          console.log("Found playlist URL:", url);
          
          // 5. Estrai i cookie correnti
          const cookies = await page.cookies();
          const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          
          clearTimeout(timeout);
          resolve({
            url: url,
            headers: {
              'Cookie': cookieHeader,
              'Referer': 'https://vixsrc.to',
              'User-Agent': 'Mozilla/5.0',
              'X-Requested-With': 'XMLHttpRequest'
            }
          });
        }
      });

      try {
        await page.goto(targetUrl, {
          waitUntil: 'networkidle2',
          timeout: 20000
        });
        
        // 6. Attendi ulteriormente per sicurezza
        await page.waitForTimeout(2000);
      } catch (err) {
        console.error('Navigation error:', err);
        reject(err);
      }
    });

    await browser.close();

    // 7. Invia sia l'URL che gli headers necessari
    res.json({
      url: playlistUrl.url,
      headers: playlistUrl.headers,
      instructions: "Use these headers when requesting the playlist URL"
    });

  } catch (err) {
    console.error("Full error:", err);
    if (browser) await browser.close();
    res.status(500).json({ 
      error: 'Error during scraping',
      details: err.message,
      solution: "The site might have upgraded its anti-bot protection. Try using a residential proxy or different IP."
    });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server avviato su 0.0.0.0:${PORT}`);
});

