require('dotenv').config();
const express = require('express');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// Configure AWS S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Configure multer memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

//Server Check
app.get('/', async(req,res)=>{
  res.json({
    message: "Server is Fine"
  })
})
// Upload endpoint
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: Date.now().toString() + '-' + req.file.originalname,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    };

    const command = new PutObjectCommand(params);
    await s3Client.send(command);
    
    const fileUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;
    
    res.json({
      message: 'Upload successful',
      location: fileUrl,
      key: params.Key
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ 
      error: 'Upload failed',
      details: err.message
    });
  }
});

// List videos endpoint
app.get('/videos', async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME
    });

    const response = await s3Client.send(command);

    const videos = await Promise.all(
      (response.Contents || []).map(async (file) => {
        const getObjectCommand = new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: file.Key
        });

        const signedUrl = await getSignedUrl(s3Client, getObjectCommand, { expiresIn: 3600 }); // 1-hour expiry

        return {
          name: file.Key,
          url: signedUrl,
          lastModified: file.LastModified,
          size: file.Size
        };
      })
    );

    res.json(videos);
  } catch (err) {
    console.error('Error listing videos:', err);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

// Configure multer
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
}).single('audio');

// Upload audio and generate signed URL
app.post('/api/audio', (req, res) => {
  audioUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: 'Audio upload error', details: err.message });
    }
    
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
      }
      
      const fileExtension = req.file.originalname.split('.').pop();
      const originalName = req.file.originalname;
      const fileId = `${Date.now()}-${uuidv4()}.${fileExtension}`;
      const fileKey = `audio/${fileId}`;

      const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: fileKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        Metadata: { originalname: originalName }, // Store the original file name
      };
      
      await s3Client.send(new PutObjectCommand(params));
      
      const signedUrl = await getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: fileKey,
      }), { expiresIn: 3600 }); // 1-hour expiry
      
      res.status(201).json({
        id: fileId,
        name: originalName, // Return the correct file name
        audioUrl: signedUrl,
        createdAt: new Date().toISOString(),
        size: req.file.size,
        type: req.file.mimetype,
      });
    } catch (err) {
      console.error('Audio upload error:', err);
      res.status(500).json({ error: 'Audio upload failed', details: err.message });
    }
  });
});

// Fetch audio recordings with signed URLs
app.get('/api/audio', async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: 'audio/',
    });
    
    const response = await s3Client.send(command);
    
    const audioFiles = await Promise.all(response.Contents.map(async (file) => {
      try {
        // Fetch metadata to get original name
        const metadata = await s3Client.send(new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: file.Key,
        }));

        const originalName = metadata.Metadata?.originalname || file.Key.split('/').pop();
        
        const signedUrl = await getSignedUrl(s3Client, new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: file.Key,
        }), { expiresIn: 3600 });

        return {
          id: file.Key.split('/').pop(), // Use only the file identifier
          name: originalName, // Use correct user-provided name
          url: signedUrl,
          lastModified: file.LastModified,
          size: file.Size,
          type: file.Key.split('.').pop(),
        };
      } catch (error) {
        console.error('Error fetching metadata:', error);
        return null; // Skip if metadata retrieval fails
      }
    }));

    // Remove null values in case of metadata retrieval failure
    res.json(audioFiles.filter(file => file !== null));
  } catch (err) {
    console.error('Error listing audio files:', err);
    res.status(500).json({ error: 'Failed to fetch audio recordings' });
  }
});

// Generate a signed URL for a specific audio file
app.get('/api/audio/:id', async (req, res) => {
  try {
    const key = `audio/${req.params.id}`;
    
    // Fetch metadata to get the original name
    const metadata = await s3Client.send(new HeadObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
    }));

    const originalName = metadata.Metadata?.originalname || req.params.id;

    const signedUrl = await getSignedUrl(s3Client, new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
    }), { expiresIn: 3600 });

    res.json({ id: req.params.id, name: originalName, url: signedUrl });
  } catch (err) {
    if (err.name === 'NotFound') {
      return res.status(404).json({ error: 'Audio recording not found' });
    }
    console.error('Error fetching audio:', err);
    res.status(500).json({ error: 'Failed to fetch audio recording' });
  }
});

// Delete an audio file
app.delete('/api/audio/:id', async (req, res) => {
  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `audio/${req.params.id}`,
    }));
    res.status(204).end();
  } catch (err) {
    console.error('Error deleting audio:', err);
    res.status(500).json({ error: 'Failed to delete audio recording' });
  }
});



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
