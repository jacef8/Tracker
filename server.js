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
app.get('/api/parcel', function(req, res) {
  var lat = parseFloat(req.query.lat);
  var lng = parseFloat(req.query.lng);
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  var geom = encodeURIComponent(JSON.stringify({"x": lng, "y": lat, "spatialReference": {"wkid": 4326}}));
  var fields = encodeURIComponent('OWN_NAME,PHY_ADDR1,PHY_CITY,ACREAGE,PARCEL_ID,CO_NO,DOR_UC,LND_VAL');
  var url = 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query' +
    '?geometry=' + geom +
    '&geometryType=esriGeometryPoint' +
    '&inSR=4326&outSR=4326' +
    '&spatialRel=esriSpatialRelIntersects' +
    '&outFields=' + fields +
    '&returnGeometry=false&resultRecordCount=1&f=json';

  var https = require('https');
  https.get(url, function(apiRes) {
    var body = '';
    apiRes.on('data', function(chunk) { body += chunk; });
    apiRes.on('end', function() {
      try {
        var data = JSON.parse(body);
        // Log for debugging
        console.log('Parcel query for', lat, lng, '-> features:', (data.features || []).length, data.error ? 'ERROR:'+JSON.stringify(data.error) : '');
        res.json(data);
      } catch(e) {
        res.status(500).json({ error: 'Parse error', raw: body.substring(0, 200) });
      }
    });
  }).on('error', function(e) {
    console.error('Parcel proxy error:', e.message);
    res.status(500).json({ error: e.message });
  });
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
