const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/version', function(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.send('1.6');
});

app.get('/777', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function() {
  console.log('GroundLink on port ' + PORT);
});
