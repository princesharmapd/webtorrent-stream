import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import path from 'path';
import yauzl from 'yauzl';
import { Readable } from 'stream';
import NodeCache from "node-cache";
import axios from "axios";

const app = express();
const client = new WebTorrent();

app.use(cors());
app.use(express.json());

const cache = new NodeCache({ stdTTL: 86400 }); // Cache for 24 hours

// Endpoint to list files in the torrent (videos, images & inside ZIPs)
app.get('/list-files/:torrentIdentifier', async (req, res) => {
  try {
    const torrentIdentifier = req.params.torrentIdentifier;
    
    // Check if it's a magnet link
    if (torrentIdentifier.startsWith('magnet:')) {
      const infoHash = extractInfoHash(torrentIdentifier);
      if (!infoHash) {
        return res.status(400).send('Invalid magnet link');
      }

      const existingTorrent = client.torrents.find((torrent) => torrent.infoHash === infoHash);
      if (existingTorrent) {
        const files = await getFiles(existingTorrent);
        return res.json(files);
      }

      client.add(torrentIdentifier, (torrent) => {
        getFiles(torrent).then((files) => res.json(files));
      });
    } 
    // Handle .torrent file URLs
    else if (torrentIdentifier.startsWith('http')) {
      const cachedFiles = cache.get(torrentIdentifier);
      if (cachedFiles) {
        return res.json(cachedFiles);
      }

      const response = await axios.get(torrentIdentifier, {
        responseType: 'arraybuffer'
      });
      
      const torrentBuffer = Buffer.from(response.data);
      client.add(torrentBuffer, (torrent) => {
        getFiles(torrent).then((files) => {
          cache.set(torrentIdentifier, files);
          res.json(files);
        });
      });
    } else {
      return res.status(400).send('Invalid torrent identifier - must be magnet link or .torrent URL');
    }
  } catch (error) {
    console.error('Error in list-files:', error);
    res.status(500).send('Error processing torrent');
  }
});

// Helper to extract infoHash from magnet link
function extractInfoHash(magnet) {
  const match = magnet.match(/urn:btih:([a-fA-F0-9]{40})/);
  return match ? match[1].toLowerCase() : null;
}

// Helper to get video and image files (including inside ZIP)
async function getFiles(torrent) {
  let fileList = [];

  for (const file of torrent.files) {
    if (getFileType(file.name) === 'zip') {
      const extractedFiles = await extractZip(file);
      fileList = fileList.concat(extractedFiles);
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

// Extract ZIP files and return list of video/image files inside
function extractZip(zipFile) {
  return new Promise((resolve, reject) => {
    const extractedFiles = [];

    zipFile.createReadStream((err, stream) => {
      if (err) return reject(err);

      let buffer = Buffer.alloc(0);

      stream.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
      });

      stream.on('end', () => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
          if (err) return reject(err);

          zip.readEntry();
          zip.on('entry', (entry) => {
            if (!entry.fileName.endsWith('/')) {
              const fileType = getFileType(entry.fileName);
              if (fileType === 'video' || fileType === 'image') {
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

// Determine file type
function getFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (['.mp4', '.mkv', '.avi'].includes(ext)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) return 'image';
  if (ext === '.zip') return 'zip';
  return 'other';
}

// Endpoint to stream a specific video file
app.get('/stream/:torrentIdentifier/:filename', (req, res) => {
  const { torrentIdentifier, filename } = req.params;
  
  let torrent;
  
  if (torrentIdentifier.startsWith('magnet:')) {
    const infoHash = extractInfoHash(torrentIdentifier);
    if (!infoHash) {
      return res.status(400).send('Invalid magnet link');
    }
    torrent = client.torrents.find((t) => t.infoHash === infoHash);
  } else if (torrentIdentifier.startsWith('http')) {
    // Find torrent by its URL
    torrent = client.torrents.find((t) => {
      return t.announce && t.announce.some(url => url.includes(new URL(torrentIdentifier).hostname));
    });
  }
  
  if (!torrent) {
    return res.status(404).send('Torrent not found');
  }

  const file = torrent.files.find((f) => f.name === filename);
  if (!file) {
    return res.status(404).send('File not found');
  }

  if (getFileType(file.name) === 'video') {
    const range = req.headers.range;
    if (!range) {
      return res.status(400).send('Requires Range header');
    }

    const fileSize = file.length;
    const [start, end] = range.replace(/bytes=/, '').split('-').map(Number);
    const chunkEnd = end || Math.min(start + 10 ** 6, fileSize - 1);
    const contentLength = chunkEnd - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${chunkEnd}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Content-Type': 'video/mp4',
    });

    const stream = file.createReadStream({ start, end: chunkEnd });

    stream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

    res.on('close', () => {
      console.log('Client disconnected, stopping stream.');
      stream.destroy();
    });

    return stream.pipe(res);
  }

  // Serve images directly
  res.setHeader('Content-Type', `image/${path.extname(file.name).substring(1)}`);
  file.createReadStream().pipe(res);
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});