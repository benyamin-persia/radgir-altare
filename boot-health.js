// Temporary health listener for Altare routing checks (PORT from platform)
const http = require('http');
const port = Number(process.env.PORT || process.env.SERVER_PORT || process.env.APP_PORT || 5000);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('radgir-ok port=' + port + '\n');
}).listen(port, '0.0.0.0', () => {
  console.log('health listening on 0.0.0.0:' + port);
});
