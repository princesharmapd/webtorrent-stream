import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import path from 'path';
import yauzl from 'yauzl';
import NodeCache from "node-cache";
import axios from "axios";
import compression from 'compression';

const app = express();
const client = new WebTorrent();
const cache = new NodeCache({ stdTTL: 86400 }); // Cache for 24 hours

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length']
}));
app.use(express.json());
app.use(compression()); // Enable compression

// Health check endpoint
app.get('/health-check', (req, res) => {
  res.json({ status: 'ok', time: new Date(), torrents: client.torrents.length });
});

// List files endpoint with caching
app.get('/list-files/:torrentIdentifier', async (req, res) => {
  try {
    const torrentIdentifier = decodeURIComponent(req.params.torrentIdentifier);
    const cachedFiles = cache.get(torrentIdentifier);
    if (cachedFiles) return res.json(cachedFiles);

    if (torrentIdentifier.startsWith('magnet:')) {
      const infoHash = extractInfoHash(torrentIdentifier);
      if (!infoHash) return res.status(400).json({ error: 'Invalid magnet link' });

      const existingTorrent = client.torrents.find(t => t.infoHash === infoHash);
      if (existingTorrent) {
        return res.json(await getFiles(existingTorrent));
      }

      client.add(torrentIdentifier, torrent => {
        getFiles(torrent).then(files => {
          cache.set(torrentIdentifier, files);
          res.json(files);
        });
      }, { maxWebConns: 50 });

    } else if (torrentIdentifier.startsWith('http')) {
      const response = await axios.get(torrentIdentifier, { responseType: 'arraybuffer', timeout: 10000 });
      client.add(Buffer.from(response.data), torrent => {
        getFiles(torrent).then(files => {
          cache.set(torrentIdentifier, files);
          res.json(files);
        });
      }, { maxWebConns: 50 });

    } else {
      return res.status(400).json({ error: 'Invalid torrent identifier' });
    }
  } catch (error) {
    console.error('List files error:', error);
    res.status(500).json({ error: 'Error processing torrent', details: error.message });
  }
});

// Stream files with bandwidth control
app.get('/stream/:torrentIdentifier/:filename', async (req, res) => {
  try {
    const torrentIdentifier = decodeURIComponent(req.params.torrentIdentifier);
    const filename = decodeURIComponent(req.params.filename);

    let torrent = getTorrent(torrentIdentifier);
    if (!torrent) return res.status(404).send('Torrent not found');

    const file = torrent.files.find(f => f.name === filename);
    if (!file) return res.status(404).send('File not found');

    if (file.length > 50 * 1024 * 1024) { // Limit large files (>50MB)
      return res.status(403).json({ error: "File too large for free tier streaming" });
    }

    const fileType = getFileType(file.name);
    const range = req.headers.range;

    if (fileType === 'video' && range) {
      const fileSize = file.length;
      const chunkSize = 512 * 1024; // 512 KB chunks
      const [start, end] = range.replace(/bytes=/, '').split('-').map(Number);
      const chunkEnd = end || Math.min(start + chunkSize, fileSize - 1);
      const contentLength = chunkEnd - start + 1;
      const contentType = getContentType(file.name);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${chunkEnd}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': contentLength,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400'
      });

      const stream = file.createReadStream({ start, end: chunkEnd });
      stream.on('error', err => console.error('Stream error:', err));
      res.on('close', () => stream.destroy());
      stream.pipe(res);

    } else if (fileType === 'image') {
      res.setHeader('Content-Type', `image/${path.extname(file.name).substring(1)}`);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      file.createReadStream().pipe(res);

    } else {
      return res.status(400).send('Unsupported file type');
    }
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).send('Streaming error');
  }
});

// Helper Functions
function extractInfoHash(magnet) {
  const match = magnet.match(/urn:btih:([a-fA-F0-9]{40})/);
  return match ? match[1].toLowerCase() : null;
}

function getTorrent(torrentIdentifier) {
  if (torrentIdentifier.startsWith('magnet:')) {
    const infoHash = extractInfoHash(torrentIdentifier);
    return client.torrents.find(t => t.infoHash === infoHash);
  }
  return null;
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const typeMap = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska'
  };
  return typeMap[ext] || 'video/mp4';
}

function getFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const videoFormats = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v'];
  const imageFormats = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  
  if (videoFormats.includes(ext)) return 'video';
  if (imageFormats.includes(ext)) return 'image';
  return 'other';
}

async function getFiles(torrent) {
  const fileList = [];
  for (const file of torrent.files) {
    fileList.push({
      name: file.name,
      length: file.length,
      path: file.path,
      type: getFileType(file.name),
    });
  }
  return fileList;
}

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
