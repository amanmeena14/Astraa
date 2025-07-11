import { VertexAI } from '@google-cloud/vertexai';
import { exec } from 'child_process';
import cors from 'cors';
import dotenv from 'dotenv';
import voice from 'elevenlabs-node';
import express from 'express';
import ffmpegPath from 'ffmpeg-static';
import { promises as fs } from 'fs';

dotenv.config();

// Set Google Cloud credentials path if not already set
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const path = require('path');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(process.cwd(), 'keys', 'astra-464811-447430499212.json');
  console.log("Set GOOGLE_APPLICATION_CREDENTIALS to:", process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

// 2️⃣ Immediately log the key so you can verify it
console.log("ELEVEN_LABS_API_KEY is:", process.env.ELEVEN_LABS_API_KEY);
const app = express();
app.use(express.json());
app.use(cors());
const port = process.env.PORT || 3000;

// Store conversation history (in production, use a database)
const conversationHistory = new Map();

// Helper to execute shell commands
const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Command failed: ${command}`);
        console.error(stderr);
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
};

// Convert MP3 to WAV and generate lip-sync JSON
const lipSyncMessage = async (messageIndex) => {
  const start = Date.now();
  console.log(`Starting conversion for message ${messageIndex}`);

  // Use ffmpeg-static binary for guaranteed availability
  const mp3Path = `audios/message_${messageIndex}.mp3`;
  const wavPath = `audios/message_${messageIndex}.wav`;
  const jsonPath = `audios/message_${messageIndex}.json`;

  // MP3 -> WAV conversion
  await execCommand(
    `"${ffmpegPath}" -y -i "${mp3Path}" "${wavPath}"`
  );
  console.log(`MP3→WAV done in ${Date.now() - start}ms`);

  // Generate lip-sync JSON with Rhubarb
const rhubarbPath = 'C:\\rhubarb-lip-sync\\rhubarb.exe';
  try {
    await execCommand(
      `"${rhubarbPath}" -f json -o "${jsonPath}" "${wavPath}" -r phonetic`
    );
  } catch (error) {
    console.log(`Rhubarb failed, trying alternative path...`);
    // Try alternative path or skip lip-sync
    const altRhubarbPath = 'rhubarb.exe';
    try {
      await execCommand(
        `"${altRhubarbPath}" -f json -o "${jsonPath}" "${wavPath}" -r phonetic`
      );
    } catch (altError) {
      console.log(`Rhubarb not available, skipping lip-sync generation`);
      // Create a basic lip-sync JSON to prevent crashes
      const basicLipSync = {
        mouthCues: [
          { start: 0, end: 1, value: "X" }
        ]
      };
      await fs.writeFile(jsonPath, JSON.stringify(basicLipSync));
    }
  }
  console.log(`Lip-sync done in ${Date.now() - start}ms`);
};

// Read and parse JSON lipsync transcript
const readJsonTranscript = async (file) => {
  const data = await fs.readFile(file, 'utf8');
  return JSON.parse(data);
};

// Read audio file and return Base64
const audioFileToBase64 = async (file) => {
  const data = await fs.readFile(file);
  return data.toString('base64');
};

// Route: health check
app.get('/', (req, res) => {
  res.send('Hello World!');
});

// Route: list available voices from ElevenLabs
app.get('/voices', async (req, res) => {
  const apiKey = process.env.ELEVEN_LABS_API_KEY;
  if (!apiKey) {
    return res.status(400).send({ error: 'ElevenLabs API key not set.' });
  }
  try {
    const voices = await voice.getVoices(apiKey);
    res.send(voices);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to fetch voices.' });
  }
});

// Route: clear conversation history
app.post('/clear-history', (req, res) => {
  const sessionId = req.body.sessionId || 'default';
  conversationHistory.delete(sessionId);
  res.send({ message: 'Conversation history cleared' });
});

// Route: check ElevenLabs API status
app.get('/tts-status', async (req, res) => {
  const apiKey = process.env.ELEVEN_LABS_API_KEY;
  if (!apiKey) {
    return res.status(400).send({ error: 'ElevenLabs API key not set.' });
  }
  try {
    const voices = await voice.getVoices(apiKey);
    res.send({ 
      status: 'working', 
      voices: voices.length,
      message: 'ElevenLabs API is working correctly'
    });
  } catch (err) {
    console.error('ElevenLabs API error:', err);
    res.status(500).send({ 
      status: 'error', 
      error: 'ElevenLabs API is not working. Check your API key and network connection.',
      details: err.message,
      type: err.code || 'unknown'
    });
  }
});

// Route: chat and generate TTS + lip-sync + emotions
app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;
  const sessionId = req.body.sessionId || 'default'; // Add session tracking
  const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Missing API keys handling
  if (!userMessage) {
    return res.send({ messages: [] });
  }
  if (!elevenLabsApiKey || !openaiKey) {
    return res.send({
      messages: [
        {
          text: "Please set your API keys for OpenAI and ElevenLabs.",
          facialExpression: 'angry',
          animation: 'Angry',
        },
      ],
    });
  }

  // Vertex AI setup with error handling
  let vertexAI;
  try {
    vertexAI = new VertexAI({
      project: 'astra-464811',
      location: 'us-central1',
    });
  } catch (error) {
    console.error('VertexAI initialization error:', error);
    return res.status(500).send({
      messages: [{
        text: "I'm having trouble connecting to my AI services right now. Please try again in a moment.",
        facialExpression: 'concerned',
        animation: 'idleGentle',
      }]
    });
  }

  const model = 'gemini-2.5-flash';
  let preview;
  try {
    preview = vertexAI.preview.getGenerativeModel({
      model,
      systemInstruction: {
        role: 'system',
        parts: [
          {
            text:
              'You are a virtual therapy bot designed to provide emotional support and advice to women. You should maintain context of the conversation and provide relevant, contextual responses. Respond with a JSON array of messages (max 3). Each message should include text, facialExpression, and animation properties. Avoid repeating the same responses.',
          },
        ],
      },
    });
  } catch (error) {
    console.error('Model initialization error:', error);
    return res.status(500).send({
      messages: [{
        text: "I'm having trouble setting up my AI model. Please try again later.",
        facialExpression: 'concerned',
        animation: 'idleGentle',
      }]
    });
  }

  // Get conversation history for this session
  const history = conversationHistory.get(sessionId) || [];
  
  // Build conversation context
  const conversationContext = [
    ...history,
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  // Send user message to Gemini with conversation history
  const request = { contents: conversationContext };
  let result;
  try {
    result = await preview.generateContent(request);
    console.log('Full response: ', JSON.stringify(result));
  } catch (error) {
    console.error('Gemini API error:', error);
    return res.status(500).send({
      messages: [{
        text: "I'm having trouble processing your message right now. Please check your internet connection and try again.",
        facialExpression: 'concerned',
        animation: 'idleGentle',
      }]
    });
  }

  // Parse JSON from response markdown
  const raw = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  let messages = [];
  try {
    messages = JSON.parse(clean);
  } catch (err) {
    console.error('JSON parse error:', err);
    return res.status(500).send({ error: 'Invalid response format.' });
  }

  // Update conversation history with user message and AI response
  const aiResponse = { role: 'model', parts: [{ text: raw }] };
  conversationHistory.set(sessionId, [
    ...history,
    { role: 'user', parts: [{ text: userMessage }] },
    aiResponse
  ].slice(-10)); // Keep last 10 messages to prevent context overflow

  // For each message: generate TTS, lip-sync, attach files
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const mp3File = `audios/message_${i}.mp3`;
    
    // Try to generate audio
    let audioGenerated = false;
    try {
      // Add timeout to prevent hanging requests
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('TTS timeout')), 10000)
      );
      
      const ttsPromise = voice.textToSpeech(elevenLabsApiKey, 'cgSgspJ2msm6clMCkdW9', mp3File, msg.text);
      await Promise.race([ttsPromise, timeoutPromise]);
      audioGenerated = true;
    } catch (error) {
      console.log(`Voice cgSgspJ2msm6clMCkdW9 failed:`, error.message);
      try {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('TTS timeout')), 10000)
        );
        const ttsPromise = voice.textToSpeech(elevenLabsApiKey, '21m00Tcm4TlvDq8ikWAM', mp3File, msg.text);
        await Promise.race([ttsPromise, timeoutPromise]);
        audioGenerated = true;
      } catch (altError) {
        console.log(`TTS failed, trying free voice...`);
        try {
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('TTS timeout')), 10000)
          );
          const ttsPromise = voice.textToSpeech(elevenLabsApiKey, 'pNInz6obpgDQGcFmaJgB', mp3File, msg.text);
          await Promise.race([ttsPromise, timeoutPromise]);
          audioGenerated = true;
        } catch (freeError) {
          console.log(`All TTS voices failed, creating silent audio file`);
          // Create a minimal silent audio file to prevent crashes
          const silentAudio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
          await fs.writeFile(mp3File, silentAudio);
          audioGenerated = true;
        }
      }
    }
    
    // Generate lip-sync if audio was created
    if (audioGenerated) {
      try {
        await lipSyncMessage(i);
        msg.lipsync = await readJsonTranscript(`audios/message_${i}.json`);
      } catch (lipSyncError) {
        console.log(`Lip-sync failed, using basic animation`);
        msg.lipsync = { mouthCues: [{ start: 0, end: 1, value: "X" }] };
      }
    } else {
      // No audio, no lip-sync needed
      msg.lipsync = { mouthCues: [{ start: 0, end: 1, value: "X" }] };
    }
    
    // Add audio to message
    try {
      msg.audio = await audioFileToBase64(mp3File);
    } catch (audioError) {
      console.log(`Failed to read audio file, using empty audio`);
      msg.audio = '';
    }
  }

  res.send({ messages });
});

app.listen(port, () => {
  console.log(`Virtual Girlfriend listening on port ${port}`);
});
