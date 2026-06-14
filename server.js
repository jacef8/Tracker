const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

// Admin password comes from Railway environment variable — never hardcoded
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Version endpoint
const CURRENT_VERSION = '1.6';
app.get('/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(CURRENT_VERSION);
});

// Admin route — password required via query param
// Access: /admin?pw=<ADMIN_PASSWORD>
// Wrong password or no password = 404 (no hint page exists)
app.get('/admin', (req, res) => {
  const provided = req.query.pw;
  if (!ADMIN_PASSWORD || !provided || provided !== ADMIN_PASSWORD) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Keep /777 redirecting to /admin for backward compat (also password-protected)
app.get('/777', (req, res) => {
  res.redirect('/admin?pw=' + (req.query.pw || ''));
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
    // Block direct access to admin.html — must go through /admin route
    if (filePath.endsWith('admin.html')) {
      res.status(404).end();
    }
  }
}));

// SPA fallback
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`GroundLink running on port ${PORT}`));
