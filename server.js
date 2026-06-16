const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

const CURRENT_VERSION = '1.7';
const TEST_PASSWORD   = process.env.TEST_PASSWORD || 'gltest';

app.get('/version', function(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.send(CURRENT_VERSION);
});

// /join — always shows join screen regardless of saved session
// Parcel lookup proxy — avoids CORS block on ArcGIS from browser
// Parcel lookup — returns a URL to Liberty County's public property search
// The ArcGIS FeatureServer requires auth tokens and cannot be queried publicly
// Instead we return a deep link to qPublic which IS public
app.get('/api/parcel', function(req, res) {
  var lat = parseFloat(req.query.lat);
  var lng = parseFloat(req.query.lng);
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  console.log('Parcel lookup:', lat, lng);
  // Return the qPublic map URL centered on these coordinates
  // Liberty County FL qPublic application
  var qpublicUrl = 'https://qpublic.schneidercorp.com/Application.aspx?App=LibertyCountyFL&Layer=Parcels&PageType=Map&Q=' + lat + '%2C' + lng;
  res.json({ qpublicUrl: qpublicUrl, lat: lat, lng: lng });
});

app.get('/join', function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.redirect('/?fresh=1');
});

// Admin route
app.get('/777', function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Test environment — password protected
// Access: /test?pw=gltest  (or set TEST_PASSWORD env var in Railway)
app.get('/test', function(req, res) {
  var provided = req.query.pw;
  if (provided !== TEST_PASSWORD) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index-test.html'));
});

// Digital Asset Links — required for TWA/Play Store verification
app.get('/.well-known/assetlinks.json', function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify([{
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.groundlink.app",
      "sha256_cert_fingerprints": ["10:09:BB:FE:B3:3B:9A:44:79:50:C8:07:88:23:25:D0:A5:AA:1A:53:75:84:29:34:5B:24:CA:0A:CD:A9:70:EB"]
    }
  }]));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
    if (filePath.endsWith('index.html') || filePath.endsWith('index-test.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    if (filePath.endsWith('admin.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

app.get('*', function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function() {
  console.log('GroundLink on port ' + PORT);
});
