import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const page = (file) => fileURLToPath(new URL(file, import.meta.url));

// Three pages: login (index), chat, admin. In dev, /api is proxied to the local API server (port 3000).
export default defineConfig({
  appType: 'mpa',
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://127.0.0.1:3000', ws: true },
      '/api': {
        target: 'http://127.0.0.1:3000',
        configure: (proxy) => {
          // If the API isn't running, answer with a clear message instead of a bare 500.
          proxy.on('error', (err, req, res) => {
            if (res.writeHead && !res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'The API server is not running on port 3000. Look at the [api] lines in your terminal for the reason.' }));
          });
        },
      },
    },
  },
  build: {
    rollupOptions: {
      input: { main: page('index.html'), chat: page('chat.html'), admin: page('admin.html') },
    },
  },
});
