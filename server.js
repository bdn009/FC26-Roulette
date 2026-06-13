import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the current directory
app.use(express.static(__dirname));

// ============================================================
// MongoDB Schemas
// ============================================================
const participantSchema = new mongoose.Schema({
  discordId: { type: String, required: true, unique: true },
  discordUsername: { type: String, required: true },
  players: { type: [String], required: true },
  submittedAt: { type: Date, default: Date.now },
});

const fixtureSchema = new mongoose.Schema({
  home: { type: String, required: true },
  away: { type: String, required: true },
  leg: { type: Number, required: true },
  stage: { type: String, default: "group_stage" },
  homeGoals: { type: Number, default: null },
  awayGoals: { type: Number, default: null },
  played: { type: Boolean, default: false },
  submittedBy: { type: String, default: null },
  playedAt: { type: Date, default: null },
});

const bracketSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: String, default: "" },
});

const tournamentConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: String, default: "" },
});

const Participant = mongoose.model("Participant", participantSchema);
const Fixture = mongoose.model("Fixture", fixtureSchema);
const Bracket = mongoose.model("Bracket", bracketSchema);
const TournamentConfig = mongoose.model("TournamentConfig", tournamentConfigSchema);

// ============================================================
// MongoDB Connection
// ============================================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ============================================================
// Helper Functions
// ============================================================
async function computeStandings() {
  const participants = await Participant.find({});
  const fixtures = await Fixture.find({ played: true });

  const stats = {};
  participants.forEach(p => {
    stats[p.discordUsername] = { name: p.discordUsername, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
  });

  fixtures.forEach(match => {
    const home = stats[match.home];
    const away = stats[match.away];
    if (!home || !away) return;

    home.p++;
    away.p++;
    home.gf += match.homeGoals;
    home.ga += match.awayGoals;
    away.gf += match.awayGoals;
    away.ga += match.homeGoals;

    if (match.homeGoals > match.awayGoals) {
      home.w++;
      away.l++;
    } else if (match.homeGoals < match.awayGoals) {
      away.w++;
      home.l++;
    } else {
      home.d++;
      away.d++;
    }
  });

  Object.values(stats).forEach(s => {
    s.gd = s.gf - s.ga;
    s.pts = (s.w * 3) + (s.d * 1);
  });

  return Object.values(stats).sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.gd !== a.gd) return b.gd - a.gd;
    return b.gf - a.gf;
  });
}

// ============================================================
// API Endpoints
// ============================================================

// Get all participants
app.get('/api/participants', async (req, res) => {
  try {
    const participants = await Participant.find({}).sort({ submittedAt: 1 });
    res.json(participants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all fixtures
app.get('/api/fixtures', async (req, res) => {
  try {
    const fixtures = await Fixture.find({}).sort({ playedAt: -1, home: 1, away: 1, leg: 1 });
    res.json(fixtures);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get standings
app.get('/api/standings', async (req, res) => {
  try {
    const standings = await computeStandings();
    res.json(standings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit a match result (from website)
app.post('/api/matches', async (req, res) => {
  try {
    const { home, away, homeGoals, awayGoals } = req.body;

    if (!home || !away) {
      return res.status(400).json({ error: "Missing home or away team" });
    }

    const fixture = await Fixture.findOne({
      $or: [
        { home: home, away: away, played: false },
        { home: away, away: home, played: false },
      ]
    }).sort({ leg: 1 });

    if (!fixture) {
      return res.status(404).json({ error: "No unplayed fixtures left between these teams." });
    }

    let actualHomeGoals, actualAwayGoals;
    if (fixture.home === home) {
      actualHomeGoals = homeGoals;
      actualAwayGoals = awayGoals;
    } else {
      actualHomeGoals = awayGoals;
      actualAwayGoals = homeGoals;
    }

    fixture.homeGoals = actualHomeGoals;
    fixture.awayGoals = actualAwayGoals;
    fixture.played = true;
    fixture.submittedBy = "website";
    fixture.playedAt = new Date();
    await fixture.save();

    res.json({ success: true, match: fixture });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a match result
app.delete('/api/matches/:id', async (req, res) => {
  try {
    const fixture = await Fixture.findById(req.params.id);
    if (!fixture) {
      return res.status(404).json({ error: "Fixture not found" });
    }
    
    fixture.homeGoals = null;
    fixture.awayGoals = null;
    fixture.played = false;
    fixture.submittedBy = null;
    fixture.playedAt = null;
    await fixture.save();
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get bracket data
app.get('/api/bracket', async (req, res) => {
  try {
    const brackets = await Bracket.find({});
    const bracketMap = {};
    brackets.forEach(b => { bracketMap[b.key] = b.value; });
    res.json(bracketMap);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save bracket data
app.post('/api/bracket', async (req, res) => {
  try {
    const bracketData = req.body;
    const ops = Object.keys(bracketData).map(key => ({
      updateOne: {
        filter: { key },
        update: { $set: { value: bracketData[key] } },
        upsert: true
      }
    }));
    
    if (ops.length > 0) {
      await Bracket.bulkWrite(ops);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get tournament status
app.get('/api/tournament/status', async (req, res) => {
  try {
    const config = await TournamentConfig.findOne({ key: "status" });
    res.json({ status: config?.value || "registration" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route for homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ FC26 Roulette API Server running on port ${PORT}`);
});
