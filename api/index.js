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
const API_URL = "https://torrent-fast-api.onrender.com/api/v1";

// Fetch and cache movies
const fetchMovies = async (endpoint, cacheKey) => {
    try {
        const response = await axios.get(`${API_URL}/${endpoint}?site=yts&limit=50`);
        const movies = response.data.data.filter(movie => movie.name && movie.poster && movie.rating);
        cache.set(cacheKey, movies);
        return movies;
    } catch (error) {
        console.error(`Error fetching ${cacheKey}:`, error);
        return cache.get(cacheKey) || []; // Return old data if API call fails
    }
};

// Background job to refresh cache every hour
const refreshCache = async () => {
    console.log("Refreshing movie cache...");
    await fetchMovies("trending", "trending_movies");
    await fetchMovies("recent", "recent_movies");
};

// Run cache refresh every 1 day
setInterval(refreshCache, 24 * 60 * 60 * 1000);

// API Endpoints
app.get("/movies/trending", async (req, res) => {
    const movies = cache.get("trending_movies") || (await fetchMovies("trending", "trending_movies"));
    res.json(movies);
});

app.get("/movies/recent", async (req, res) => {
    const movies = cache.get("recent_movies") || (await fetchMovies("recent", "recent_movies"));
    res.json(movies);
});

app.get("/movies/search", async (req, res) => {
    const { query, page = 1 } = req.query;
    if (!query) return res.status(400).json({ error: "Query is required!" });

    const cacheKey = `search_${query}_${page}`;
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    try {
        const response = await axios.get(`${API_URL}/search?site=yts&query=${query}&limit=10&page=${page}`);
        const movies = response.data.data.filter(movie => movie.name && movie.poster && movie.rating);
        cache.set(cacheKey, movies, 86400); // Cache search results for 24 hours
        res.json(movies);
    } catch (error) {
        res.status(500).json({ error: "Error fetching search results." });
    }
});

app.get("/movies/all", async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: "Query is required!" });

    const cacheKey = `all_search_${query}`;
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    try {
        const response = await axios.get(`${API_URL}/all/search?query=${query}&limit=0`);
        const movies = response.data.data.filter(movie => movie.name && movie.poster); // Removed movie.rating check
        cache.set(cacheKey, movies, 86400);
        res.json(movies);
    } catch (error) {
        res.status(500).json({ error: "Error fetching all search results." });
    }
});
// Endpoint to list files in the torrent (videos, images & inside ZIPs)
app.get('/list-files/:magnet', (req, res) => {
  const magnet = req.params.magnet;
  const infoHash = extractInfoHash(magnet);

  if (!infoHash) {
    return res.status(400).send('Invalid magnet link');
  }

  const existingTorrent = client.torrents.find((torrent) => torrent.infoHash === infoHash);

  if (existingTorrent) {
    return getFiles(existingTorrent).then((files) => res.json(files));
  }

  client.add(magnet, (torrent) => {
    getFiles(torrent).then((files) => res.json(files));
  });
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
app.get('/stream/:magnet/:filename', (req, res) => {
  const { magnet, filename } = req.params;
  const infoHash = extractInfoHash(magnet);

  if (!infoHash) {
    return res.status(400).send('Invalid magnet link');
  }

  const torrent = client.torrents.find((t) => t.infoHash === infoHash);
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
