const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

// Version endpoint — clients poll this to detect updates
const CURRENT_VERSION = '1.6'; // bump this with APP_VERSION in index.html on every deploy
app.get('/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(CURRENT_VERSION);
});

// Admin route — must be BEFORE the static middleware and catch-all
app.get('/777', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    if (filePath.endsWith('admin.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// SPA fallback — everything else goes to index.html
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`GroundLink running on port ${PORT}`));
