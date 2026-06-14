const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '8888';
const CURRENT_VERSION = '1.6';

app.get('/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(CURRENT_VERSION);
});

app.get('/admin', (req, res) => {
  const provided = req.query.pw;
  if (provided !== ADMIN_PASSWORD) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/777', (req, res) => {
  res.redirect(301, '/admin?pw=' + ADMIN_PASSWORD);
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
  }
}));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('GroundLink on port ' + PORT));
