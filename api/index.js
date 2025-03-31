import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import path from 'path';
import yauzl from 'yauzl';
import NodeCache from "node-cache";
import axios from "axios";

const app = express();
const client = new WebTorrent();

// Enhanced CORS configuration
app.use(cors({
  origin: true,
  credentials: true,
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length']
}));

app.use(express.json());

const cache = new NodeCache({ stdTTL: 86400 }); // Cache for 24 hours

// Health check endpoint
app.get('/health-check', (req, res) => {
  res.json({ status: 'ok', time: new Date(), torrents: client.torrents.length });
});

// List files endpoint
// Updated endpoint to list files, including folders
app.get('/list-files/:torrentIdentifier', async (req, res) => {
  try {
    const torrentIdentifier = decodeURIComponent(req.params.torrentIdentifier);
    
    if (torrentIdentifier.startsWith('magnet:')) {
      const infoHash = extractInfoHash(torrentIdentifier);
      if (!infoHash) return res.status(400).json({ error: 'Invalid magnet link' });

      const existingTorrent = client.torrents.find(t => t.infoHash === infoHash);
      if (existingTorrent) {
        return res.json(await getFiles(existingTorrent));
      }

      client.add(torrentIdentifier, torrent => {
        getFiles(torrent).then(files => res.json(files));
      }, { maxWebConns: 50 });
      
    } else if (torrentIdentifier.startsWith('http')) {
      const cachedFiles = cache.get(torrentIdentifier);
      if (cachedFiles) return res.json(cachedFiles);

      const response = await axios.get(torrentIdentifier, {
        responseType: 'arraybuffer',
        timeout: 10000
      });
      
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


// Stream endpoint with format support
app.get('/stream/:torrentIdentifier/:filename', async (req, res) => {
  try {
    const torrentIdentifier = decodeURIComponent(req.params.torrentIdentifier);
    const filename = decodeURIComponent(req.params.filename);
    
    let torrent;
    if (torrentIdentifier.startsWith('magnet:')) {
      const infoHash = extractInfoHash(torrentIdentifier);
      if (!infoHash) return res.status(400).send('Invalid magnet link');
      torrent = client.torrents.find(t => t.infoHash === infoHash);
    } else if (torrentIdentifier.startsWith('http')) {
      const hostname = new URL(torrentIdentifier).hostname;
      torrent = client.torrents.find(t => {
        return t.announce && t.announce.some(url => url.includes(hostname));
      });
    }
    
    if (!torrent) return res.status(404).send('Torrent not found');

    const file = torrent.files.find(f => f.name === filename);
    if (!file) return res.status(404).send('File not found');

    const fileType = getFileType(file.name);
    const range = req.headers.range;

    if (fileType === 'video') {
      if (!range) return res.status(400).send('Range header required');

      const fileSize = file.length;
      const [start, end] = range.replace(/bytes=/, '').split('-').map(Number);
      const chunkEnd = end || Math.min(start + 10 ** 6, fileSize - 1);
      const contentLength = chunkEnd - start + 1;

      // Dynamic content type based on file extension
      const contentType = getContentType(file.name);
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${chunkEnd}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': contentLength,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
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

// Helper functions
function extractInfoHash(magnet) {
  const match = magnet.match(/urn:btih:([a-fA-F0-9]{40})/);
  return match ? match[1].toLowerCase() : null;
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
  if (ext === '.zip') return 'zip';
  return 'other';
}

async function getFiles(torrent) {
  const fileList = [];
  for (const file of torrent.files) {
    if (getFileType(file.name) === 'zip') {
      try {
        fileList.push(...await extractZip(file));
      } catch (err) {
        console.error('Error extracting zip:', err);
      }
    } else {
      fileList.push({
        name: file.name,
        length: file.length,
        path: file.path,
        type: getFileType(file.name),
      });
    }
  }
  return fileList;
}

function extractZip(zipFile) {
  return new Promise((resolve, reject) => {
    const extractedFiles = [];
    zipFile.createReadStream((err, stream) => {
      if (err) return reject(err);
      
      let buffer = Buffer.alloc(0);
      stream.on('data', chunk => buffer = Buffer.concat([buffer, chunk]));
      stream.on('end', () => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
          if (err) return reject(err);
          
          zip.readEntry();
          zip.on('entry', entry => {
            if (!entry.fileName.endsWith('/')) {
              const fileType = getFileType(entry.fileName);
              if (['video', 'image'].includes(fileType)) {
                extractedFiles.push({
                  name: entry.fileName,
                  length: entry.uncompressedSize,
                  path: zipFile.path + '/' + entry.fileName,
                  type: fileType,
                });
              }
            }
            zip.readEntry();
          });
          zip.on('end', () => resolve(extractedFiles));
        });
      });
    });
  });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
