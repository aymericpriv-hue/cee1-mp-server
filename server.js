/**
 * ============================================================================
 *  CEE1-QUIZ — SERVEUR MULTIJOUEUR TEMPS RÉEL
 *  Node.js + Express + Socket.io
 * ============================================================================
 *
 *  Ce serveur gère DEUX modes de jeu :
 *
 *  1. DUEL 1V1 ("duel")   — gratuit, exactement 2 joueurs, code à 4 chiffres.
 *  2. BATAILLE DE SECTION ("battle") — illimité (3 à 50+ joueurs), la CRÉATION
 *     du salon exige un compte Premium (vérifié côté serveur via Firebase),
 *     mais rejoindre avec un code est toujours gratuit pour tout le monde.
 *
 *  Tout l'état des parties (rooms) est gardé EN MÉMOIRE (une simple Map).
 *  C'est volontairement simple : pas besoin de base de données pour ça,
 *  une partie ne doit pas survivre à un redémarrage du serveur.
 *
 *  IMPORTANT — SÉCURITÉ DU SCORING :
 *  Le client n'envoie JAMAIS "j'ai gagné X points". Il envoie seulement
 *  "j'ai choisi la réponse N à l'instant T". C'est TOUJOURS le serveur qui
 *  calcule si c'est juste et combien de points ça vaut. Un joueur ne peut
 *  donc pas tricher en modifiant son propre code JavaScript côté client.
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const admin = require('firebase-admin');

// ----------------------------------------------------------------------------
// 1. INITIALISATION FIREBASE ADMIN (pour vérifier qui est vraiment Premium)
// ----------------------------------------------------------------------------
// Le fichier de clé de service NE DOIT JAMAIS être mis sur GitHub.
// Sur Render/Railway, on le fournit via une variable d'environnement
// (voir les instructions de déploiement fournies séparément).
let adminSdkReady = false;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  adminSdkReady = true;
  console.log('[Firebase Admin] Initialisé avec succès.');
} catch (e) {
  console.error('[Firebase Admin] ÉCHEC d\'initialisation — la vérification Premium ne fonctionnera pas.', e.message);
}

// ----------------------------------------------------------------------------
// 2. CONFIGURATION EXPRESS + SOCKET.IO
// ----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('CEE1-Quiz multiplayer server — OK'));
// Petite route de "santé" pratique pour vérifier que le serveur tourne,
// et pour éviter qu'il ne s'endorme sur les hébergeurs gratuits (voir doc).
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.use(express.json());

// ============================================================
// PANEL ADMIN — endpoints protégés.
// Un compte est admin si (et seulement si) un document existe
// dans la collection Firestore `admins/{uid}` — créé À LA MAIN
// dans la console Firebase. Aucun mot de passe dans le code.
// ============================================================
async function requireAdmin(req, res) {
  if (!adminSdkReady) { res.status(503).json({ error: 'Firebase non initialisé côté serveur.' }); return null; }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Connexion requise.' }); return null; }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const adminDoc = await admin.firestore().collection('admins').doc(decoded.uid).get();
    if (!adminDoc.exists) { res.status(403).json({ error: 'Ce compte n\'est pas administrateur.' }); return null; }
    return decoded.uid;
  } catch (e) {
    res.status(401).json({ error: 'Jeton invalide ou expiré — reconnecte-toi.' });
    return null;
  }
}

// Liste des comptes + statut premium + stats globales
app.post('/admin/list-users', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const users = [];
    let pageToken = undefined;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      page.users.forEach(u => users.push(u));
      pageToken = page.pageToken;
    } while (pageToken && users.length < 5000);

    const accessSnap = await admin.firestore().collection('access').get();
    const paidSet = new Set();
    accessSnap.forEach(doc => { if (doc.data().paid === true) paidSet.add(doc.id); });

    const list = users.map(u => ({
      uid: u.uid,
      pseudo: (u.email || '').replace('@cee1quiz.local', '') || u.displayName || '(sans pseudo)',
      provider: (u.providerData[0] && u.providerData[0].providerId) || 'password',
      created: u.metadata.creationTime,
      lastLogin: u.metadata.lastSignInTime,
      paid: paidSet.has(u.uid)
    })).sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ ok: true, total: list.length, paidCount: list.filter(u => u.paid).length, users: list });
  } catch (e) {
    console.error('[admin/list-users]', e.message);
    res.status(500).json({ error: 'Erreur serveur pendant la lecture des comptes.' });
  }
});

// Agrège les stats du défi du jour sur les N derniers jours (fonction pure, testée)
function aggregateDailyStats(docs, lastYmds) {
  const perDay = {};
  lastYmds.forEach(ymd => { perDay[ymd] = { ymd, participants: 0, correct: 0 }; });
  const activeUids = new Set();
  docs.forEach(d => {
    const sep = d.id.indexOf('_');
    if (sep === -1) return;
    const ymd = d.id.slice(0, sep);
    const uid = d.id.slice(sep + 1);
    if (!perDay[ymd]) return;
    perDay[ymd].participants++;
    if (d.data.correct === true) perDay[ymd].correct++;
    activeUids.add(uid);
  });
  const days = lastYmds.map(ymd => {
    const p = perDay[ymd];
    return { ymd, participants: p.participants, successPct: p.participants > 0 ? Math.round(p.correct / p.participants * 100) : null };
  });
  return { days, activeUids: activeUids.size };
}

// Tableau de bord : comptes, actifs 7 jours, défi du jour, défis entre camarades
app.post('/admin/stats', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const lastYmds = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      lastYmds.push(d.toISOString().slice(0, 10));
    }
    const [dailySnap, boardSnap, chSnap] = await Promise.all([
      admin.firestore().collection('daily')
        .where(admin.firestore.FieldPath.documentId(), '>=', lastYmds[0] + '_')
        .where(admin.firestore.FieldPath.documentId(), '<=', lastYmds[6] + '_\uf8ff')
        .get(),
      admin.firestore().collection('leaderboard').where('weekId', '==', 'alltime').get(),
      admin.firestore().collection('challenges').where('status', '==', 'pending').get()
    ]);
    const dailyDocs = [];
    dailySnap.forEach(doc => dailyDocs.push({ id: doc.id, data: doc.data() }));
    const agg = aggregateDailyStats(dailyDocs, lastYmds);
    res.json({
      ok: true,
      totalRanked: boardSnap.size,
      activeDaily7d: agg.activeUids,
      pendingChallenges: chSnap.size,
      days: agg.days
    });
  } catch (e) {
    console.error('[admin/stats]', e.message);
    res.status(500).json({ error: 'Erreur serveur pendant le calcul des stats.' });
  }
});

// ---- IA (clé ANTHROPIC_API_KEY dans les variables d'environnement Render) ----
const AI_MODEL = 'claude-haiku-4-5-20251001';
const aiQuota = {}; // { uid: { day, count } } — remis à zéro au redémarrage, suffisant

function checkAiQuota(uid, map, maxPerDay, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (!map[uid] || map[uid].day !== day) map[uid] = { day, count: 0 };
  if (map[uid].count >= maxPerDay) return false;
  map[uid].count++;
  return true;
}

function parseClaudeJson(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('['), startObj = clean.indexOf('{');
  const from = (start !== -1 && (startObj === -1 || start < startObj)) ? start : startObj;
  if (from === -1) return null;
  try { return JSON.parse(clean.slice(from)); } catch (e) { return null; }
}

async function callClaude(prompt, maxTokens) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('NO_KEY');
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: maxTokens || 800,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!resp.ok) throw new Error('API_' + resp.status);
  const data = await resp.json();
  return (data.content || []).map(c => c.text || '').join('\n');
}

// Admin : générer 3 mauvaises réponses plausibles pour une question
app.post('/admin/ai-distractors', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const { question, correct } = req.body || {};
  if (!question || !correct || String(question).length > 400 || String(correct).length > 250) {
    return res.status(400).json({ error: 'Question et bonne réponse requises (tailles raisonnables).' });
  }
  try {
    const text = await callClaude(
      'Tu prépares un QCM pour le concours CEE1 de la Police Nationale française (élèves gardiens de la paix).\n'
      + 'Question : « ' + String(question).slice(0, 400) + ' »\n'
      + 'Bonne réponse : « ' + String(correct).slice(0, 250) + ' »\n'
      + 'Écris 3 mauvaises réponses PLAUSIBLES (même style, même longueur approximative, erreurs crédibles pour un élève, jamais absurdes).\n'
      + 'Réponds UNIQUEMENT avec un tableau JSON de 3 chaînes, sans autre texte. Exemple : ["…","…","…"]', 300);
    const arr = parseClaudeJson(text);
    if (!Array.isArray(arr) || arr.length < 3) return res.status(502).json({ error: 'Réponse IA inexploitable — réessaie.' });
    res.json({ ok: true, distractors: arr.slice(0, 3).map(d => String(d).slice(0, 200)) });
  } catch (e) {
    if (e.message === 'NO_KEY') return res.status(503).json({ error: 'Clé IA absente : ajoute ANTHROPIC_API_KEY dans les variables Render.' });
    console.error('[admin/ai-distractors]', e.message);
    res.status(502).json({ error: 'Service IA indisponible — réessaie dans un instant.' });
  }
});

// Premium : générer des fiches de révision depuis un extrait de cours (5/jour/personne)
app.post('/ai/generate-fiches', async (req, res) => {
  const { idToken, text } = req.body || {};
  const isPremium = await verifyPremium(idToken);
  if (!isPremium) return res.status(403).json({ error: 'Réservé aux comptes Premium.' });
  let uid = null;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; } catch (e) { return res.status(401).json({ error: 'Session invalide.' }); }
  if (!text || typeof text !== 'string' || text.trim().length < 60) {
    return res.status(400).json({ error: 'Colle au moins quelques phrases de ton cours (60 caractères minimum).' });
  }
  if (!checkAiQuota(uid, aiQuota, 5, Date.now())) {
    return res.status(429).json({ error: 'Limite atteinte : 5 générations par jour — reviens demain !' });
  }
  try {
    const out = await callClaude(
      'Tu aides un élève gardien de la paix à réviser le concours CEE1 (Police Nationale française).\n'
      + 'Voici un extrait de son cours :\n---\n' + text.slice(0, 4000) + '\n---\n'
      + 'Crée entre 4 et 10 fiches de révision recto/verso à partir de ce contenu UNIQUEMENT (pas d\'invention).\n'
      + 'Recto = une question courte et précise. Verso = la réponse exacte tirée du cours.\n'
      + 'Réponds UNIQUEMENT avec un tableau JSON d\'objets {"front":"…","back":"…"}, sans autre texte.', 1200);
    const arr = parseClaudeJson(out);
    if (!Array.isArray(arr) || arr.length === 0) return res.status(502).json({ error: 'Réponse IA inexploitable — réessaie.' });
    const fiches = arr
      .filter(f => f && typeof f.front === 'string' && typeof f.back === 'string' && f.front.trim().length >= 3 && f.back.trim().length >= 1)
      .slice(0, 10)
      .map(f => ({ front: f.front.slice(0, 300), back: f.back.slice(0, 300) }));
    if (fiches.length === 0) return res.status(502).json({ error: 'Aucune fiche exploitable — reformule ton extrait.' });
    res.json({ ok: true, fiches });
  } catch (e) {
    if (e.message === 'NO_KEY') return res.status(503).json({ error: 'Fonction IA pas encore activée par l\'administrateur.' });
    console.error('[ai/generate-fiches]', e.message);
    res.status(502).json({ error: 'Service IA indisponible — réessaie dans un instant.' });
  }
});

// Lister les fiches proposées par les élèves (à transformer en questions ou rejeter)
app.post('/admin/list-proposals', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const snap = await admin.firestore().collection('proposals').get();
    const list = [];
    snap.forEach(doc => {
      const d = doc.data();
      list.push({
        id: doc.id,
        pseudo: String(d.pseudo || '?').slice(0, 20),
        front: String(d.front || '').slice(0, 300),
        back: String(d.back || '').slice(0, 300),
        at: d.at || 0
      });
    });
    list.sort((a, b) => b.at - a.at);
    res.json({ ok: true, proposals: list.slice(0, 200) });
  } catch (e) {
    console.error('[admin/list-proposals]', e.message);
    res.status(500).json({ error: 'Erreur serveur pendant la lecture des propositions.' });
  }
});

// Supprimer une proposition (après conversion en question, ou rejet)
app.post('/admin/delete-proposal', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const { id } = req.body || {};
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id manquant.' });
  try {
    await admin.firestore().collection('proposals').doc(id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin/delete-proposal]', e.message);
    res.status(500).json({ error: 'Erreur serveur pendant la suppression.' });
  }
});

// Lister toutes les questions personnalisées (actives et inactives)
app.post('/admin/list-questions', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const snap = await admin.firestore().collection('questions').orderBy('updatedAt', 'desc').limit(500).get();
    const list = [];
    snap.forEach(doc => {
      const d = doc.data();
      list.push({ id: doc.id, q: d.q || '', options: d.options || [], correct: d.correct || 0, theme: d.theme || 'cee1', active: d.active !== false });
    });
    res.json({ ok: true, builtinCount: BUILTIN_QUESTIONS.length, questions: list });
  } catch (e) {
    console.error('[admin/list-questions]', e.message);
    res.status(500).json({ error: 'Lecture des questions impossible.' });
  }
});

// Créer ou modifier une question (validée avant enregistrement)
app.post('/admin/save-question', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const body = req.body || {};
  const valid = validateCustomQuestion(body);
  if (!valid) {
    res.status(400).json({ error: 'Question invalide : énoncé (5-300 caractères), 4 réponses non vides (≤200 caractères), bonne réponse entre 1 et 4.' });
    return;
  }
  try {
    const payload = {
      q: valid.q, options: valid.options, correct: valid.correct, theme: valid.theme,
      active: body.active !== false,
      updatedBy: adminUid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    let id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim().slice(0, 64) : null;
    if (id) {
      await admin.firestore().collection('questions').doc(id).set(payload, { merge: true });
    } else {
      const ref = await admin.firestore().collection('questions').add(payload);
      id = ref.id;
    }
    reloadQuestionBank(); // le multijoueur voit la nouvelle question sans redémarrage
    res.json({ ok: true, id });
  } catch (e) {
    console.error('[admin/save-question]', e.message);
    res.status(500).json({ error: 'Enregistrement impossible.' });
  }
});

// Supprimer définitivement une question
app.post('/admin/delete-question', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const { id } = req.body || {};
  if (typeof id !== 'string' || !id.trim()) { res.status(400).json({ error: 'id manquant.' }); return; }
  try {
    await admin.firestore().collection('questions').doc(id.trim().slice(0, 64)).delete();
    reloadQuestionBank();
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin/delete-question]', e.message);
    res.status(500).json({ error: 'Suppression impossible.' });
  }
});

// Message du jour affiché sur l'accueil du site (bandeau)
app.post('/admin/set-announcement', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const { text, active } = req.body || {};
  if (typeof text !== 'string' || text.length > 300) {
    res.status(400).json({ error: 'Texte manquant ou trop long (300 caractères max).' });
    return;
  }
  try {
    await admin.firestore().collection('config').doc('announcement').set({
      text: text.trim(),
      active: active === true && text.trim().length > 0,
      updatedBy: adminUid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin/set-announcement]', e.message);
    res.status(500).json({ error: 'Enregistrement impossible.' });
  }
});

// ============================================================
// TOURNOI DE PROMO — bracket à élimination directe (4, 8 ou 16)
// Stocké dans config/tournament ; écrit uniquement ici.
// ============================================================
function buildBracket(players) {
  if (!Array.isArray(players)) return null;
  const clean = [];
  const seen = new Set();
  players.forEach(p => {
    const name = String(p || '').trim().slice(0, 20);
    if (name.length >= 2 && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      clean.push(name);
    }
  });
  if (![4, 8, 16].includes(clean.length)) return null;
  for (let i = clean.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [clean[i], clean[j]] = [clean[j], clean[i]];
  }
  const firstRound = [];
  for (let i = 0; i < clean.length; i += 2) {
    firstRound.push({ p1: clean[i], p2: clean[i + 1], winner: null });
  }
  return { players: clean, rounds: [firstRound] };
}

// Applique un résultat, fait avancer le bracket ; renvoie {rounds, status, winnerPseudo}
function reportWinner(rounds, roundIndex, matchIndex, winner) {
  if (!Array.isArray(rounds) || !rounds[roundIndex] || !rounds[roundIndex][matchIndex]) return null;
  if (roundIndex !== rounds.length - 1) return null; // on ne modifie que le tour en cours
  const match = rounds[roundIndex][matchIndex];
  if (winner !== match.p1 && winner !== match.p2) return null;
  match.winner = winner;
  const current = rounds[roundIndex];
  if (current.every(m => m.winner !== null)) {
    if (current.length === 1) {
      return { rounds, status: 'done', winnerPseudo: current[0].winner };
    }
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push({ p1: current[i].winner, p2: current[i + 1].winner, winner: null });
    }
    rounds.push(next);
  }
  return { rounds, status: 'live', winnerPseudo: null };
}

app.post('/admin/create-tournament', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const { name, players } = req.body || {};
  const bracket = buildBracket(players);
  if (!bracket) {
    res.status(400).json({ error: 'Il faut exactement 4, 8 ou 16 pseudos valides et différents (2-20 caractères).' });
    return;
  }
  const tName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 60) : 'Tournoi de promo';
  try {
    await admin.firestore().collection('config').doc('tournament').set({
      name: tName,
      status: 'live',
      players: bracket.players,
      rounds: JSON.stringify(bracket.rounds),
      winnerPseudo: null,
      createdBy: adminUid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin/create-tournament]', e.message);
    res.status(500).json({ error: 'Création impossible.' });
  }
});

app.post('/admin/report-winner', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const { roundIndex, matchIndex, winner } = req.body || {};
  try {
    const ref = admin.firestore().collection('config').doc('tournament');
    const doc = await ref.get();
    if (!doc.exists || doc.data().status !== 'live') {
      res.status(400).json({ error: 'Aucun tournoi en cours.' });
      return;
    }
    const rounds = JSON.parse(doc.data().rounds || '[]');
    const result = reportWinner(rounds, parseInt(roundIndex, 10), parseInt(matchIndex, 10), String(winner || ''));
    if (!result) {
      res.status(400).json({ error: 'Résultat invalide (mauvais match, mauvais tour ou vainqueur inconnu).' });
      return;
    }
    await ref.set({
      rounds: JSON.stringify(result.rounds),
      status: result.status,
      winnerPseudo: result.winnerPseudo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true, status: result.status, winnerPseudo: result.winnerPseudo });
  } catch (e) {
    console.error('[admin/report-winner]', e.message);
    res.status(500).json({ error: 'Enregistrement impossible.' });
  }
});

app.post('/admin/close-tournament', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    await admin.firestore().collection('config').doc('tournament').delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Suppression impossible.' });
  }
});

// ============================================================
// SAISONS — couronnement mensuel + panthéon (config/season)
// ============================================================
app.post('/admin/crown-season', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const { seasonName, champion } = req.body || {};
  if (typeof seasonName !== 'string' || !seasonName.trim() || seasonName.length > 60
    || typeof champion !== 'string' || !champion.trim() || champion.length > 20) {
    res.status(400).json({ error: 'Nom de saison (≤60) et pseudo du champion (≤20) requis.' });
    return;
  }
  try {
    const ref = admin.firestore().collection('config').doc('season');
    const doc = await ref.get();
    const history = (doc.exists && Array.isArray(doc.data().history)) ? doc.data().history : [];
    history.push({ name: seasonName.trim(), champion: champion.trim() });
    while (history.length > 24) history.shift();
    await ref.set({ history, updatedBy: adminUid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin/crown-season]', e.message);
    res.status(500).json({ error: 'Enregistrement impossible.' });
  }
});

// Accorder / retirer le premium à un compte
app.post('/admin/set-paid', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const { targetUid, paid } = req.body || {};
  if (typeof targetUid !== 'string' || !targetUid.trim() || targetUid.length > 128) {
    res.status(400).json({ error: 'targetUid manquant ou invalide.' });
    return;
  }
  try {
    await admin.firestore().collection('access').doc(targetUid.trim()).set({
      paid: paid === true,
      via: 'admin-panel',
      grantedBy: adminUid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true, targetUid: targetUid.trim(), paid: paid === true });
  } catch (e) {
    console.error('[admin/set-paid]', e.message);
    res.status(500).json({ error: 'Écriture impossible.' });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
  // origin: '*' = accepte les connexions depuis n'importe quel site.
  // Tu peux le restreindre à ton domaine GitHub Pages une fois que tout
  // fonctionne, pour plus de sécurité : origin: 'https://aymericpriv-hue.github.io'
});

// ----------------------------------------------------------------------------
// 3. BANQUE DE QUESTIONS (format QCM — nécessaire pour la correction serveur)
// ----------------------------------------------------------------------------
// ⚠️ Ceci est un JEU DE DÉPART de 12 questions, reformulées en QCM à partir
// de vraies questions CEE1. Complète/remplace ce tableau avec ta propre
// banque — chaque question DOIT avoir exactement une bonne réponse dont
// l'index est indiqué dans "correct".
const QUESTIONS_MP = [
  {"q":"Que signifie le sigle F.P.R. ?","options":["Fichier des Personnes Recherchées","Force de Police Rapide","Fiche de Poursuite et Recherche","Fichier Provisoire des Réquisitions"],"correct":0,"theme":"cee1"},
  {"q":"Quelle est la durée de l'enquête de flagrant délit ?","options":["24 heures","48 heures","8 jours","15 jours"],"correct":2,"theme":"cee1"},
  {"q":"Comment s'appelle la décision rendue par le tribunal correctionnel ?","options":["Un arrêt","Une ordonnance","Un jugement","Un verdict"],"correct":2,"theme":"cee1"},
  {"q":"Quel article du Code de procédure pénale prévoit le contrôle d'identité sur réquisition du procureur ?","options":["L'article 78-1","L'article 78-2 alinéa 7","L'article 62-2","L'article 53"],"correct":1,"theme":"cee1"},
  {"q":"Combien de juges composent le tribunal correctionnel ?","options":["1 juge","2 juges","3 juges","5 juges"],"correct":2,"theme":"cee1"},
  {"q":"Quel est l'élément qui N'EST PAS un élément constitutif d'une infraction ?","options":["Élément légal","Élément matériel","Élément moral","Élément financier"],"correct":3,"theme":"cee1"},
  {"q":"Quel grade correspond à l'insigne d'un galon doré ?","options":["Gardien de la paix","Brigadier","Brigadier-chef","Major"],"correct":2,"theme":"cee1"},
  {"q":"Que signifie l'abréviation O.P.J. ?","options":["Officier de Police Judiciaire","Ordre de Poursuite Judiciaire","Officier Principal de Justice","Opération de Police Judiciaire"],"correct":0,"theme":"cee1"},
  {"q":"Quelle lettre de l'alphabet OTAN correspond au mot \"Foxtrot\" ?","options":["E","F","G","P"],"correct":1,"theme":"cee1"},
  {"q":"La garde à vue est une mesure de :","options":["Rétention administrative","Rétention judiciaire","Rétention civile","Rétention préventive"],"correct":1,"theme":"cee1"},
  {"q":"Quel est le sigle de la Police aux Frontières ?","options":["P.A.F.","P.J.","B.A.C.","C.R.S."],"correct":0,"theme":"cee1"},
  {"q":"Un mandat d'arrêt est délivré par :","options":["Le préfet","Le maire","Un magistrat","Un OPJ"],"correct":2,"theme":"cee1"},
  {"q":"Que signifie le sigle B.A.C. ?","options":["Brigade Anti-Criminalité","Bureau d'Aide aux Citoyens","Brigade d'Assistance et de Contrôle","Bureau d'Administration Centrale"],"correct":0,"theme":"cee1"},
  {"q":"Quelle lettre de l'alphabet OTAN correspond au mot \"Whiskey\" ?","options":["V","W","X","U"],"correct":1,"theme":"cee1"},
  {"q":"Combien de temps dure la garde à vue de droit commun (renouvellement compris) ?","options":["24 heures","48 heures","72 heures","96 heures"],"correct":1,"theme":"cee1"},
  {"q":"Que signifie le sigle C.R.S. ?","options":["Compagnies Républicaines de Sécurité","Corps Régional de Sécurité","Compagnie de Renseignement et Surveillance","Centre de Réponse et Secours"],"correct":0,"theme":"cee1"},
  {"q":"Quel est le grade juste au-dessus de Gardien de la paix ?","options":["Brigadier","Brigadier-chef","Major","Lieutenant"],"correct":0,"theme":"cee1"},
  {"q":"Que signifie le sigle D.G.P.N. ?","options":["Direction Générale de la Police Nationale","Département de Gestion du Personnel National","Direction Générale du Personnel National","Délégation Générale du Personnel de la Nation"],"correct":0,"theme":"cee1"},
  {"q":"Quelle lettre de l'alphabet OTAN correspond au mot \"Charlie\" ?","options":["A","B","C","K"],"correct":2,"theme":"cee1"},
  {"q":"Un flagrant délit peut être constaté jusqu'à combien de temps après les faits ?","options":["Immédiatement uniquement","1 heure","Un temps très voisin de l'action","24 heures"],"correct":2,"theme":"cee1"},
  {"q":"Que signifie le sigle P.J. dans le contexte policier ?","options":["Police Judiciaire","Procureur de Justice","Police de Justice","Poursuite Judiciaire"],"correct":0,"theme":"cee1"},
  {"q":"Quel tribunal juge les délits ?","options":["Le tribunal de police","Le tribunal correctionnel","La cour d'assises","Le tribunal administratif"],"correct":1,"theme":"cee1"},
  {"q":"Que signifie le sigle B.R.I. ?","options":["Brigade de Recherche et d'Intervention","Bureau du Renseignement Intérieur","Brigade Régionale d'Investigation","Bureau de Répression et Investigation"],"correct":0,"theme":"cee1"},
  {"q":"Quelle lettre de l'alphabet OTAN correspond au mot \"Sierra\" ?","options":["S","Z","C","X"],"correct":0,"theme":"cee1"},
  {"q":"Qui dirige une enquête préliminaire ?","options":["Le juge d'instruction","Le procureur de la République","Le préfet","L'OPJ seul, sans contrôle"],"correct":1,"theme":"cee1"},
  {"q":"Que signifie le sigle S.D.P.J. ?","options":["Sous-Direction de la Police Judiciaire","Service Départemental de la Police Judiciaire","Section Départementale de Protection Judiciaire","Service de Défense et Protection Juridique"],"correct":1,"theme":"cee1"},
  {"q":"Quel grade correspond à l'échelon juste sous Commissaire ?","options":["Commandant","Capitaine","Lieutenant","Major"],"correct":0,"theme":"cee1"},
  {"q":"Que signifie le sigle O.C.R.V.P. ?","options":["Office Central pour la Répression des Violences aux Personnes","Organisation Centrale de Renseignement et Veille Policière","Office Central de Recherche des Personnes Vulnérables","Organisme de Contrôle et Répression des Violences Publiques"],"correct":0,"theme":"cee1"},
  {"q":"Quelle lettre de l'alphabet OTAN correspond au mot \"Tango\" ?","options":["T","D","G","N"],"correct":0,"theme":"cee1"},
  {"q":"Que signifie le sigle U.S.I.C. ?","options":["Unité de Sécurisation et d'Intervention Ciblée","Unité de Soutien et d'Intervention de la Circulation","Union Syndicale des Inspecteurs et Commissaires","Unité Spéciale d'Intervention et de Contrôle"],"correct":0,"theme":"cee1"}
];

// ----------------------------------------------------------------------------
// QUESTIONS AUTO-GÉNÉRÉES depuis les vraies fiches du site (ALPHABET + ORGS).
// Générées automatiquement — si tu modifies l'alphabet ou les organisations
// dans quiz-cee1.html, demande une régénération de ce bloc pour rester synchro.
// ----------------------------------------------------------------------------
const QUESTIONS_FROM_SITE = [
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre A ?", options: ["Zulu", "Papa", "Sierra", "Alpha"], correct: 3, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre B ?", options: ["Quebec", "Bravo", "Golf", "Romeo"], correct: 1, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre C ?", options: ["Charlie", "Foxtrot", "Delta", "Kilo"], correct: 0, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre D ?", options: ["Delta", "Papa", "Yankee", "Victor"], correct: 0, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre E ?", options: ["Charlie", "Bravo", "Echo", "Romeo"], correct: 2, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre F ?", options: ["Uniform", "Zulu", "Alpha", "Foxtrot"], correct: 3, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre G ?", options: ["Tango", "Golf", "Romeo", "Hotel"], correct: 1, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre H ?", options: ["Hotel", "Whiskey", "Alpha", "Quebec"], correct: 0, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre I ?", options: ["India", "Oscar", "Sierra", "Charlie"], correct: 0, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre J ?", options: ["Kilo", "Juliett", "Alpha", "Romeo"], correct: 1, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre K ?", options: ["Delta", "Juliett", "November", "Kilo"], correct: 3, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre L ?", options: ["Golf", "Lima", "Whiskey", "Alpha"], correct: 1, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre M ?", options: ["X-ray", "Mike", "Oscar", "November"], correct: 1, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre N ?", options: ["November", "Whiskey", "Zulu", "India"], correct: 0, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre O ?", options: ["Alpha", "November", "Oscar", "Kilo"], correct: 2, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre P ?", options: ["Papa", "Alpha", "Delta", "X-ray"], correct: 0, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre Q ?", options: ["Sierra", "Foxtrot", "Quebec", "Whiskey"], correct: 2, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre R ?", options: ["Yankee", "Zulu", "Echo", "Romeo"], correct: 3, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre S ?", options: ["November", "Sierra", "Delta", "Mike"], correct: 1, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre T ?", options: ["Alpha", "Tango", "Sierra", "Juliett"], correct: 1, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre U ?", options: ["Victor", "Sierra", "Uniform", "Tango"], correct: 2, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre V ?", options: ["Victor", "Oscar", "India", "Golf"], correct: 0, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre W ?", options: ["Mike", "Charlie", "Whiskey", "Juliett"], correct: 2, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre X ?", options: ["X-ray", "Uniform", "Hotel", "Sierra"], correct: 0, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre Y ?", options: ["Lima", "Yankee", "Oscar", "Tango"], correct: 1, theme: "alphabet" },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre Z ?", options: ["Zulu", "Sierra", "Mike", "Echo"], correct: 0, theme: "alphabet" },
  { q: "Que signifie le sigle DGPN ?", options: ["Direction Générale de la Police Nationale", "Direction Générale des Douanes et Droits Indirects", "Service de la Transformation Numérique", "Inspection Générale de la Police Nationale"], correct: 0, theme: "orgs" },
  { q: "Que signifie le sigle DNPJ ?", options: ["Préfecture de Police (Paris)", "Direction Nationale de la Police aux Frontières", "Service de la Protection", "Direction Nationale de la Police Judiciaire"], correct: 3, theme: "orgs" },
  { q: "Que signifie le sigle DNSP ?", options: ["Direction Nationale de la Sécurité Publique", "Direction Nationale de la Police Judiciaire", "Direction Nationale du Renseignement Territorial", "Direction de la Sécurité de Proximité de l'Agglomération Parisienne"], correct: 0, theme: "orgs" },
  { q: "Que signifie le sigle DNPAF ?", options: ["Unité de Coordination de la Lutte AntiTerroriste", "Direction de la Coopération Internationale de Sécurité", "Direction Nationale de la Police aux Frontières", "Préfecture de Police (Paris)"], correct: 2, theme: "orgs" },
  { q: "Que signifie le sigle DNRT ?", options: ["Direction Centrale des Compagnies Républicaines de Sécurité", "Direction Nationale de la Sécurité Publique", "Inspection Générale de la Police Nationale", "Direction Nationale du Renseignement Territorial"], correct: 3, theme: "orgs" },
  { q: "Que signifie le sigle DCCRS ?", options: ["Direction Générale des Douanes et Droits Indirects", "Direction des Ressources Humaines, des Finances et des Soutiens", "Direction Centrale des Compagnies Républicaines de Sécurité", "Direction de la Coopération Internationale de Sécurité"], correct: 2, theme: "orgs" },
  { q: "Que signifie le sigle DCRFPN ?", options: ["Direction Générale de la Sécurité Intérieure", "Inspection Générale de la Police Nationale", "Direction Centrale du Recrutement et de la Formation de la Police Nationale", "Unité de Coordination de la Lutte AntiTerroriste"], correct: 2, theme: "orgs" },
  { q: "Que signifie le sigle DRHFS ?", options: ["Direction de la Sécurité de Proximité de l'Agglomération Parisienne", "Direction des Ressources Humaines, des Finances et des Soutiens", "Service de la Transformation Numérique", "Brigade de Recherche et d'Intervention"], correct: 1, theme: "orgs" },
  { q: "Que signifie le sigle IGPN ?", options: ["Inspection Générale de la Police Nationale", "Direction Nationale du Renseignement Territorial", "Recherche, Assistance, Intervention, Dissuasion", "Direction Générale de la Sécurité Intérieure"], correct: 0, theme: "orgs" },
  { q: "Que signifie le sigle DCIS ?", options: ["Préfecture de Police (Paris)", "Direction de la Coopération Internationale de Sécurité", "Direction Générale de la Police Nationale", "Brigade de Recherche et d'Intervention"], correct: 1, theme: "orgs" },
  { q: "Que signifie le sigle STN ?", options: ["Service de la Transformation Numérique", "Direction Nationale de la Sécurité Publique", "Préfecture de Police (Paris)", "Direction Générale des Douanes et Droits Indirects"], correct: 0, theme: "orgs" },
  { q: "Que signifie le sigle RAID ?", options: ["Recherche, Assistance, Intervention, Dissuasion", "Direction Nationale de la Sécurité Publique", "Direction Nationale du Renseignement Territorial", "Service de la Transformation Numérique"], correct: 0, theme: "orgs" },
  { q: "Que signifie le sigle BRI ?", options: ["Brigade de Recherche et d'Intervention", "Direction Nationale du Renseignement Territorial", "Direction Nationale de la Police Judiciaire", "Service de la Transformation Numérique"], correct: 0, theme: "orgs" },
  { q: "Que signifie le sigle SDLP ?", options: ["Unité de Coordination de la Lutte AntiTerroriste", "Direction Nationale de la Sécurité Publique", "Direction Générale de la Police Nationale", "Service de la Protection"], correct: 3, theme: "orgs" },
  { q: "Que signifie le sigle UCLAT ?", options: ["Brigade de Recherche et d'Intervention", "Unité de Coordination de la Lutte AntiTerroriste", "Direction Générale de la Sécurité Civile et de la Gestion des Crises", "Direction Générale des Douanes et Droits Indirects"], correct: 1, theme: "orgs" },
  { q: "Que signifie le sigle DGSI ?", options: ["Direction Nationale de la Sécurité Publique", "Direction Générale de la Sécurité Intérieure", "Direction Générale de la Sécurité Civile et de la Gestion des Crises", "Direction Nationale de la Police aux Frontières"], correct: 1, theme: "orgs" },
  { q: "Que signifie le sigle PP ?", options: ["Unité de Coordination de la Lutte AntiTerroriste", "Brigade de Recherche et d'Intervention", "Direction Régionale de la Police Judiciaire (Paris)", "Préfecture de Police (Paris)"], correct: 3, theme: "orgs" },
  { q: "Que signifie le sigle DSPAP ?", options: ["Direction Générale de la Sécurité Civile et de la Gestion des Crises", "Préfecture de Police (Paris)", "Direction de la Sécurité de Proximité de l'Agglomération Parisienne", "Direction Générale de la Police Nationale"], correct: 2, theme: "orgs" },
  { q: "Que signifie le sigle DOPC ?", options: ["Direction de l'Ordre Public et de la Circulation", "Direction des Ressources Humaines, des Finances et des Soutiens", "Direction Générale de la Police Nationale", "Direction Générale de la Sécurité Intérieure"], correct: 0, theme: "orgs" },
  { q: "Que signifie le sigle DRPJ ?", options: ["Direction Générale de la Police Nationale", "Direction Régionale de la Police Judiciaire (Paris)", "Inspection Générale de la Police Nationale", "Recherche, Assistance, Intervention, Dissuasion"], correct: 1, theme: "orgs" },
  { q: "Que signifie le sigle DGDDI ?", options: ["Service de la Transformation Numérique", "Préfecture de Police (Paris)", "Direction Centrale des Compagnies Républicaines de Sécurité", "Direction Générale des Douanes et Droits Indirects"], correct: 3, theme: "orgs" },
  { q: "Que signifie le sigle DGSCGC ?", options: ["Service de la Transformation Numérique", "Direction Générale de la Sécurité Civile et de la Gestion des Crises", "Inspection Générale de la Police Nationale", "Brigade de Recherche et d'Intervention"], correct: 1, theme: "orgs" }
];

// La banque complète = questions manuelles (procédure/CEE1) + fiches du site.
const BUILTIN_QUESTIONS = QUESTIONS_MP.concat(QUESTIONS_FROM_SITE);
let ALL_QUESTIONS_MP = BUILTIN_QUESTIONS.slice();

// Valide une question personnalisée venue de Firestore avant de la servir aux joueurs.
function validateCustomQuestion(data) {
  if (!data || typeof data.q !== 'string' || !Array.isArray(data.options)) return null;
  const q = data.q.trim().slice(0, 300);
  if (q.length < 5) return null;
  if (data.options.length !== 4) return null;
  const options = data.options.map(o => String(o).trim().slice(0, 200));
  if (options.some(o => o.length === 0)) return null;
  const correct = parseInt(data.correct, 10);
  if (isNaN(correct) || correct < 0 || correct > 3) return null;
  const themes = ['cee1', 'alphabet', 'orgs'];
  const theme = themes.includes(data.theme) ? data.theme : 'cee1';
  return { q, options, correct, theme };
}

// Recharge la banque (questions intégrées + questions actives ajoutées via le panel admin).
// En cas d'échec Firestore, la banque intégrée continue de fonctionner seule.
async function reloadQuestionBank() {
  if (!adminSdkReady) return;
  try {
    const snap = await admin.firestore().collection('questions').where('active', '==', true).get();
    const customs = [];
    snap.forEach(doc => {
      const valid = validateCustomQuestion(doc.data());
      if (valid) customs.push(valid);
    });
    ALL_QUESTIONS_MP = BUILTIN_QUESTIONS.concat(customs);
    console.log('[Questions] Banque rechargée : ' + BUILTIN_QUESTIONS.length + ' intégrées + ' + customs.length + ' personnalisées.');
  } catch (e) {
    console.error('[Questions] Rechargement impossible (banque intégrée conservée) :', e.message);
  }
}
reloadQuestionBank();
setInterval(reloadQuestionBank, 5 * 60 * 1000); // rafraîchit toutes les 5 minutes

const QUESTION_TIME_MS = 15000;   // 15 secondes par question (défaut, modifiable par le créateur)
const MAX_MISSED_BEFORE_KICK = 3; // 3 questions sans répondre = exclusion pour inactivité

// Options choisies par le créateur du salon, avec bornes de sécurité.
function sanitizeGameOptions(opts) {
  opts = opts || {};
  const themes = ['all', 'cee1', 'alphabet', 'orgs'];
  const theme = themes.includes(opts.theme) ? opts.theme : 'all';
  let count = parseInt(opts.questionCount, 10);
  if (isNaN(count)) count = 10;
  count = Math.max(5, Math.min(30, count));
  let timeMs = parseInt(opts.timePerQuestionSec, 10) * 1000;
  if (isNaN(timeMs)) timeMs = QUESTION_TIME_MS;
  timeMs = Math.max(5000, Math.min(90000, timeMs)); // 5 s à 1 min 30
  return { theme, count, timeMs };
}

function questionPoolFor(theme) {
  if (theme === 'all') return ALL_QUESTIONS_MP;
  return ALL_QUESTIONS_MP.filter(q => q.theme === theme);
}
const DUEL_QUESTION_COUNT = 10;
const MAX_SPEED_BONUS = 100;      // bonus max si on répond instantanément (façon Kahoot)
const POINTS_PER_CORRECT = 100;

// ----------------------------------------------------------------------------
// 4. ÉTAT DES SALONS (rooms) — tout est en mémoire
// ----------------------------------------------------------------------------
/**
 * Structure d'une room :
 * {
 *   code: '4821',
 *   mode: 'duel' | 'battle',
 *   creatorSocketId: 'xxxx',
 *   players: Map(socketId -> { pseudo, score, answers: [], connected: true }),
 *   status: 'lobby' | 'in-progress' | 'finished',
 *   questionOrder: [indices mélangés dans QUESTIONS_MP],
 *   currentQuestionIndex: 0,
 *   currentQuestionStartedAt: timestamp,
 *   questionTimer: setTimeout handle
 * }
 */
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000)); // 4 chiffres
  } while (rooms.has(code));
  return code;
}

// ----------------------------------------------------------------------------
// MODÉRATION — nettoyage des pseudos et limites anti-abus
// ----------------------------------------------------------------------------
const BANNED_WORDS = ['connard', 'salope', 'pute', 'encule', 'enculé', 'fdp', 'ntm', 'nique', 'batard', 'bâtard', 'pd', 'bite', 'couille'];

function sanitizePseudo(raw) {
  let p = String(raw || '').trim().slice(0, 20);          // longueur max 20
  p = p.replace(/[<>\"'&]/g, '');                          // caractères HTML dangereux
  const lower = p.toLowerCase();
  for (const word of BANNED_WORDS) {
    if (lower.includes(word)) return 'Joueur';             // pseudo insultant -> remplacé
  }
  return p.length > 0 ? p : 'Joueur';
}

// Anti-spam : chaque connexion (socket) ne peut créer que 3 salons par 10 minutes.
const roomCreationLog = new Map(); // socketId -> [timestamps]
function canCreateRoom(socketId) {
  const now = Date.now();
  const log = (roomCreationLog.get(socketId) || []).filter(t => now - t < 10 * 60 * 1000);
  if (log.length >= 3) return false;
  log.push(now);
  roomCreationLog.set(socketId, log);
  return true;
}

// Tire "count" questions du thème demandé ; renvoie des indices dans ALL_QUESTIONS_MP.
function pickQuestionOrder(count, theme) {
  const pool = questionPoolFor(theme || 'all');
  const indices = pool.map(q => ALL_QUESTIONS_MP.indexOf(q));
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, Math.min(count, indices.length));
}

function sanitizeFlair(flair) {
  flair = flair || {};
  return {
    color: (typeof flair.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(flair.color)) ? flair.color : '',
    avatar: (typeof flair.avatar === 'string') ? flair.avatar.slice(0, 4) : '',
    gold: flair.gold === true
  };
}

function publicPlayerList(room) {
  return Array.from(room.players.values()).map(p => ({ pseudo: p.pseudo, score: p.score, connected: p.connected, color: p.color || '', avatar: p.avatar || '', gold: !!p.gold }));
}

function top5(room) {
  return Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(p => ({ pseudo: p.pseudo, score: p.score, color: p.color || '', avatar: p.avatar || '', gold: !!p.gold }));
}

function finalPodium(room) {
  return Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ pseudo: p.pseudo, score: p.score, rank: i + 1, color: p.color || '', avatar: p.avatar || '', gold: !!p.gold }));
}

// ----------------------------------------------------------------------------
// 5. VÉRIFICATION PREMIUM (pour la création d'une Bataille de Section)
// ----------------------------------------------------------------------------
// Le client envoie son "ID token" Firebase (récupéré via
// firebase.auth().currentUser.getIdToken()). On le vérifie ici, puis on
// regarde dans Firestore si ce compte a bien payé — exactement la même
// source de vérité que le paywall du site principal.
async function verifyPremium(idToken) {
  if (!idToken) return false;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const doc = await admin.firestore().collection('access').doc(decoded.uid).get();
    return doc.exists && doc.data().paid === true;
  } catch (e) {
    console.error('[verifyPremium] échec :', e.message);
    return false;
  }
}

// ----------------------------------------------------------------------------
// 6. LOGIQUE DE PARTIE — envoi des questions, gestion du chrono, scoring
// ----------------------------------------------------------------------------
function startGame(room) {
  room.status = 'in-progress';
  room.currentQuestionIndex = -1;
  sendNextQuestion(room);
}

function sendNextQuestion(room) {
  room.currentQuestionIndex++;

  const totalQuestions = room.questionOrder.length;
  if (room.currentQuestionIndex >= totalQuestions) {
    endGame(room);
    return;
  }

  const qIndex = room.questionOrder[room.currentQuestionIndex];
  const question = room.questionSet[qIndex];
  room.currentQuestionStartedAt = Date.now();
  room.answersThisQuestion = new Map(); // socketId -> { correct, timeMs }

  const timeMs = room.timePerQuestionMs || QUESTION_TIME_MS;
  io.to(room.code).emit('question', {
    index: room.currentQuestionIndex,
    total: totalQuestions,
    text: question.q,
    options: question.options,
    timeLimitMs: timeMs
  });

  if (room.questionTimer) clearTimeout(room.questionTimer);
  room.questionTimer = setTimeout(() => {
    revealAndAdvance(room);
  }, timeMs + 300); // petite marge réseau
}

function revealAndAdvance(room) {
  const qIndex = room.questionOrder[room.currentQuestionIndex];
  const question = room.questionSet[qIndex];

  // Inactivité : un joueur connecté qui n'a pas répondu gagne 0 point et
  // son compteur monte ; à MAX_MISSED_BEFORE_KICK de suite, il est exclu.
  for (const [sid, player] of room.players.entries()) {
    if (!player.connected) continue;
    if (room.answersThisQuestion.has(sid)) {
      player.missedCount = 0; // il a répondu : compteur remis à zéro
    } else {
      player.missedCount = (player.missedCount || 0) + 1;
      if (player.missedCount >= MAX_MISSED_BEFORE_KICK) {
        player.connected = false;
        const targetSocket = io.sockets.sockets.get(sid);
        if (targetSocket) {
          targetSocket.emit('kicked', { reason: 'Exclu pour inactivité (' + MAX_MISSED_BEFORE_KICK + ' questions sans réponse). Tu peux revenir avec le code du salon.' });
          targetSocket.leave(room.code);
        }
      }
    }
  }

  io.to(room.code).emit('question-result', {
    correctOptionIndex: question.correct,
    scores: publicPlayerList(room)
  });

  // En mode Bataille, on affiche le Top 5 entre chaque question.
  if (room.mode === 'battle') {
    io.to(room.code).emit('leaderboard-update', top5(room));
  }

  const isLastQuestion = room.currentQuestionIndex >= room.questionOrder.length - 1;
  const delay = isLastQuestion ? 1500 : 3000; // pause avant la question suivante

  setTimeout(() => {
    sendNextQuestion(room);
  }, delay);
}

function endGame(room) {
  room.status = 'finished';
  if (room.questionTimer) clearTimeout(room.questionTimer);
  const podium = finalPodium(room);
  io.to(room.code).emit('game-over', { podium });

  // Enregistre un récapitulatif persistant pour les Batailles de Section,
  // consultable ensuite depuis le site (écran "Historique des batailles").
  if (room.mode === 'battle') {
    const playerUids = Array.from(room.players.values())
      .map(p => p.uid)
      .filter(uid => typeof uid === 'string' && uid.length > 0);
    const results = Array.from(room.players.values())
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ uid: p.uid || null, pseudo: p.pseudo, score: p.score, rank: i + 1 }));

    admin.firestore().collection('battles').add({
      code: room.code,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      playerCount: results.length,
      playerUids,
      results
    }).catch(err => console.error('[battles] échec enregistrement récapitulatif :', err.message));
  }
}

// ----------------------------------------------------------------------------
// 7. GESTION DES CONNEXIONS SOCKET.IO
// ----------------------------------------------------------------------------
io.on('connection', (socket) => {

  // ---- Créer un duel 1v1 (gratuit) ----
  socket.on('create-duel', ({ pseudo, uid, options, flair, spectator }, callback) => {
    if (!canCreateRoom(socket.id)) {
      callback({ ok: false, error: 'Trop de salons créés récemment — attends quelques minutes.' });
      return;
    }
    pseudo = sanitizePseudo(pseudo);
    const gameOpts = sanitizeGameOptions(options);
    const code = generateRoomCode();
    const room = {
      code,
      mode: 'duel',
      creatorSocketId: socket.id,
      players: new Map(),
      status: 'lobby',
      timePerQuestionMs: gameOpts.timeMs,
      theme: gameOpts.theme,
      questionCount: gameOpts.count,
      questionSet: ALL_QUESTIONS_MP,
      questionOrder: pickQuestionOrder(gameOpts.count, gameOpts.theme)
    };
    // Mode vidéoprojecteur : l'animateur crée et pilote le salon mais ne joue pas.
    room.isHosted = spectator === true;
    if (!room.isHosted) {
      const f = sanitizeFlair(flair);
      room.players.set(socket.id, { pseudo: pseudo || 'Joueur', uid: uid || null, color: f.color, avatar: f.avatar, gold: f.gold, score: 0, connected: true, missedCount: 0 });
    }
    rooms.set(code, room);

    socket.join(code);
    callback({ ok: true, code });
    io.to(code).emit('players-update', publicPlayerList(room));
  });

  // ---- Créer une Bataille de Section (Premium uniquement) ----
  socket.on('create-battle', async ({ pseudo, idToken, uid, options, flair, spectator }, callback) => {
    const isPremium = await verifyPremium(idToken);
    if (!isPremium) {
      callback({ ok: false, error: 'Compte Premium requis pour créer une Bataille de Section.' });
      return;
    }
    if (!canCreateRoom(socket.id)) {
      callback({ ok: false, error: 'Trop de salons créés récemment — attends quelques minutes.' });
      return;
    }
    pseudo = sanitizePseudo(pseudo);
    const gameOpts = sanitizeGameOptions(options);
    const code = generateRoomCode();
    const room = {
      code,
      mode: 'battle',
      creatorSocketId: socket.id,
      players: new Map(),
      status: 'lobby',
      timePerQuestionMs: gameOpts.timeMs,
      theme: gameOpts.theme,
      questionCount: gameOpts.count,
      questionSet: ALL_QUESTIONS_MP,
      questionOrder: pickQuestionOrder(gameOpts.count, gameOpts.theme)
    };
    // Mode vidéoprojecteur : l'animateur crée et pilote le salon mais ne joue pas.
    room.isHosted = spectator === true;
    if (!room.isHosted) {
      const f = sanitizeFlair(flair);
      room.players.set(socket.id, { pseudo: pseudo || 'Joueur', uid: uid || null, color: f.color, avatar: f.avatar, gold: f.gold, score: 0, connected: true, missedCount: 0 });
    }
    rooms.set(code, room);

    socket.join(code);
    callback({ ok: true, code });
    io.to(code).emit('players-update', publicPlayerList(room));
  });

  // ---- Rejoindre un salon (duel OU bataille) avec un code — toujours gratuit ----
  socket.on('join-room', ({ code, pseudo, uid, flair }, callback) => {
    const room = rooms.get(code);
    if (!room) { callback({ ok: false, error: 'Code invalide — ce salon n\'existe pas.' }); return; }

    // ---- REJOINDRE EN COURS DE PARTIE ----
    // Si la partie a commencé, on cherche une "place" laissée par ce joueur
    // (départ volontaire, déconnexion ou exclusion) : même compte, ou à défaut
    // même pseudo. Il reprend alors sa place AVEC ses points.
    if (room.status === 'in-progress') {
      pseudo = sanitizePseudo(pseudo);
      let oldSid = null;
      for (const [sid, p] of room.players.entries()) {
        if (p.connected) continue;
        if (uid && p.uid && p.uid === uid) { oldSid = sid; break; }
        if (!oldSid && p.pseudo === pseudo) { oldSid = sid; }
      }
      if (!oldSid) {
        callback({ ok: false, error: 'Cette partie a déjà commencé (seul un joueur qui en faisait partie peut la reprendre en cours).' });
        return;
      }
      const player = room.players.get(oldSid);
      room.players.delete(oldSid);
      player.connected = true;
      player.missedCount = 0;
      room.players.set(socket.id, player);
      socket.join(code);
      callback({ ok: true, code, mode: room.mode, rejoined: true });
      io.to(code).emit('players-update', publicPlayerList(room));

      // Renvoie immédiatement la question en cours avec le temps restant réel.
      const qIndex = room.questionOrder[room.currentQuestionIndex];
      const question = room.questionSet[qIndex];
      if (question) {
        const timeMs = room.timePerQuestionMs || QUESTION_TIME_MS;
        const remaining = Math.max(0, timeMs - (Date.now() - room.currentQuestionStartedAt));
        socket.emit('question', {
          index: room.currentQuestionIndex,
          total: room.questionOrder.length,
          text: question.q,
          options: question.options,
          timeLimitMs: remaining
        });
      }
      return;
    }

    if (room.status !== 'lobby') { callback({ ok: false, error: 'Cette partie est terminée.' }); return; }
    if (room.mode === 'duel' && room.players.size >= 2) {
      callback({ ok: false, error: 'Ce duel est déjà complet (2 joueurs).' });
      return;
    }
    if (room.mode === 'battle' && room.players.size >= 60) {
      callback({ ok: false, error: 'Ce salon est complet (60 joueurs maximum).' });
      return;
    }
    pseudo = sanitizePseudo(pseudo);

    const f = sanitizeFlair(flair);
    room.players.set(socket.id, { pseudo: pseudo || 'Joueur', uid: uid || null, color: f.color, avatar: f.avatar, gold: f.gold, score: 0, connected: true, missedCount: 0 });
    socket.join(code);
    callback({ ok: true, code, mode: room.mode });
    io.to(code).emit('players-update', publicPlayerList(room));

    // Le duel démarre automatiquement dès que les 2 joueurs sont là.
    if (room.mode === 'duel' && room.players.size === 2) {
      io.to(code).emit('game-starting', { countdownMs: 3000 });
      setTimeout(() => startGame(room), 3000);
    }
  });

  // ---- Le créateur lance la partie (mode Bataille uniquement) ----
  socket.on('start-game', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.creatorSocketId !== socket.id) return; // seul le créateur peut lancer
    if (room.status !== 'lobby') return;
    if (room.players.size < 1) return;
    if (room.isHosted && room.players.size < 2) return; // au tableau : au moins 2 joueurs

    io.to(code).emit('game-starting', { countdownMs: 3000 });
    setTimeout(() => startGame(room), 3000);
  });

  // ---- Un joueur répond à la question en cours ----
  socket.on('submit-answer', ({ code, optionIndex }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'in-progress') return;
    if (!room.players.has(socket.id)) return; // l'animateur ne répond pas
    if (room.answersThisQuestion.has(socket.id)) return; // une seule réponse par question

    const qIndex = room.questionOrder[room.currentQuestionIndex];
    const question = room.questionSet[qIndex];
    const elapsedMs = Date.now() - room.currentQuestionStartedAt;
    const isCorrect = optionIndex === question.correct;
    const timeMs = room.timePerQuestionMs || QUESTION_TIME_MS;

    let pointsEarned = 0;
    if (isCorrect) {
      const timeRemainingMs = Math.max(0, timeMs - elapsedMs);
      const speedBonus = Math.round((timeRemainingMs / timeMs) * MAX_SPEED_BONUS);
      pointsEarned = POINTS_PER_CORRECT + speedBonus;
    }

    room.answersThisQuestion.set(socket.id, { correct: isCorrect, elapsedMs });

    // Écran tableau : « X/Y ont répondu »
    const connectedCount = Array.from(room.players.values()).filter(p => p.connected).length;
    io.to(code).emit('answer-count', { answered: room.answersThisQuestion.size, total: connectedCount });
    const player = room.players.get(socket.id);
    if (player) player.score += pointsEarned;

    socket.emit('answer-ack', { correct: isCorrect, pointsEarned, yourScore: player ? player.score : 0 });

    // Si tout le monde a répondu, on n'attend pas la fin du chrono.
    if (room.answersThisQuestion.size >= connectedCount) {
      if (room.questionTimer) clearTimeout(room.questionTimer);
      revealAndAdvance(room);
    }
  });

  // ---- Revanche (redémarre une nouvelle partie dans le même salon) ----
  // ---- Exclure un joueur (créateur uniquement, en salle d'attente) ----
  socket.on('kick-player', ({ code, targetPseudo }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.creatorSocketId !== socket.id) return;      // seul le créateur peut exclure
    if (room.status !== 'lobby') return;                 // uniquement avant le début

    for (const [sid, player] of room.players.entries()) {
      if (player.pseudo === targetPseudo && sid !== socket.id) {
        room.players.delete(sid);
        const targetSocket = io.sockets.sockets.get(sid);
        if (targetSocket) {
          targetSocket.emit('kicked', { reason: 'Tu as été exclu du salon par le créateur.' });
          targetSocket.leave(code);
        }
        break; // n'exclut que le premier pseudo correspondant
      }
    }
    io.to(code).emit('players-update', publicPlayerList(room));
  });

  socket.on('request-rematch', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players.forEach(p => { p.score = 0; p.missedCount = 0; });
    room.status = 'lobby';
    room.questionSet = ALL_QUESTIONS_MP; // la revanche repart sur la banque à jour
    room.questionOrder = pickQuestionOrder(room.questionCount || (room.mode === 'duel' ? DUEL_QUESTION_COUNT : 15), room.theme || 'all');
    io.to(code).emit('players-update', publicPlayerList(room));
    io.to(code).emit('rematch-ready');
  });

  // ---- Quitter un salon proprement (bouton "Quitter" côté client) ----
  socket.on('leave-room', ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.players.has(socket.id)) return;

    if (room.status === 'lobby') {
      // En salle d'attente : retrait complet de la liste.
      room.players.delete(socket.id);
    } else {
      // En cours de partie : on le marque déconnecté (son score reste au podium,
      // et le décompte "tout le monde a répondu" ne l'attend plus).
      const player = room.players.get(socket.id);
      if (player) player.connected = false;
    }
    socket.leave(code); // stoppe immédiatement tous les événements du salon pour lui

    const remaining = Array.from(room.players.values()).filter(p => p.connected);
    if (remaining.length === 0) {
      if (room.questionTimer) clearTimeout(room.questionTimer);
      rooms.delete(code);
      return;
    }
    io.to(code).emit('players-update', publicPlayerList(room));
  });

  // ---- Déconnexion ----
  socket.on('disconnect', () => {
    roomCreationLog.delete(socket.id); // purge du journal anti-spam
    for (const [code, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        const player = room.players.get(socket.id);
        player.connected = false;
        io.to(code).emit('players-update', publicPlayerList(room));

        // Nettoyage : si plus personne de connecté, on supprime la room
        // après un court délai (laisse une chance de reconnexion).
        setTimeout(() => {
          const stillThere = Array.from(room.players.values()).some(p => p.connected);
          if (!stillThere) {
            if (room.questionTimer) clearTimeout(room.questionTimer);
            rooms.delete(code);
          }
        }, 30000);
      }
    }
  });
});

// ----------------------------------------------------------------------------
// 8. DÉMARRAGE DU SERVEUR
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur multijoueur CEE1-Quiz démarré sur le port ${PORT}`);
});
