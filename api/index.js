import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import NodeCache from "node-cache";
import axios from "axios";

const app = express();
const client = new WebTorrent();

app.use(cors());
app.use(express.json());
const cache = new NodeCache({ stdTTL: 86400 });

// Health check
app.get('/health-check', (req, res) => {
  res.json({ status: 'ok', time: new Date(), torrents: client.torrents.length });
});

// List files endpoint
app.get('/list-files/:torrentIdentifier', async (req, res) => {
  try {
    const torrentIdentifier = decodeURIComponent(req.params.torrentIdentifier);
    
    if (torrentIdentifier.startsWith('magnet:')) {
      const infoHash = extractInfoHash(torrentIdentifier);
      if (!infoHash) return res.status(400).json({ error: 'Invalid magnet link' });

      const existingTorrent = client.torrents.find(t => t.infoHash === infoHash);
      if (existingTorrent) return res.json(await getFiles(existingTorrent));

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

// Download endpoint only
// Download endpoint only
app.get('/download/:torrentIdentifier/:filename', async (req, res) => {
  let torrent;
  let file;
  let stream;

  try {
    const { torrentIdentifier, filename } = req.params;
    const decodedFilename = decodeURIComponent(filename);
    
    if (torrentIdentifier.startsWith('magnet:')) {
      const infoHash = extractInfoHash(torrentIdentifier);
      torrent = client.torrents.find(t => t.infoHash === infoHash);
    } else {
      const hostname = new URL(torrentIdentifier).hostname;
      torrent = client.torrents.find(t => 
        t.announce?.some(url => url.includes(hostname))
      );
    }

    if (!torrent) {
      if (torrentIdentifier.startsWith('magnet:')) {
        torrent = client.add(torrentIdentifier);
      } else {
        const response = await axios.get(torrentIdentifier, {
          responseType: 'arraybuffer',
          timeout: 10000
        });
        torrent = client.add(Buffer.from(response.data));
      }
      
      await new Promise(resolve => torrent.on('metadata', resolve));
    }

    file = torrent.files.find(f => f.name === decodedFilename);
    if (!file) return res.status(404).send('File not found');

    // Set download headers
    res.setHeader('Content-Disposition', `attachment; filename="${decodedFilename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', file.length);
    res.setHeader('Accept-Ranges', 'bytes');

    // Handle range requests for streaming
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Content-Length': chunksize
      });

      stream = file.createReadStream({ start, end });
    } else {
      stream = file.createReadStream();
    }

    // Handle client disconnects
    const cleanup = () => {
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
      req.off('close', cleanup);
      res.off('close', cleanup);
      res.off('finish', cleanup);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);

    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).end();
      }
      console.error('Stream error:', err.message);
      cleanup();
    });

    stream.pipe(res);

  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).send('Download failed');
    }
    if (stream && !stream.destroyed) {
      stream.destroy();
    }
  }
});

// Helper functions
function extractInfoHash(magnet) {
  const match = magnet.match(/urn:btih:([a-fA-F0-9]{40})/);
  return match?.[1]?.toLowerCase();
}

function getFileType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const video = ['mp4', 'mkv', 'avi', 'mov', 'webm'];
  return video.includes(ext) ? 'video' : 'other';
}

async function getFiles(torrent) {
  return torrent.files.map(file => ({
    name: file.name,
    length: file.length,
    type: getFileType(file.name),
    path: file.path
  }));
}

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});