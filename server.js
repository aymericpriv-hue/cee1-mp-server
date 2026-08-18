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
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
  { q: "Que signifie le sigle F.P.R. ?", options: ["Fichier des Personnes Recherchées", "Force de Police Rapide", "Fiche de Poursuite et Recherche", "Fichier Provisoire des Réquisitions"], correct: 0 },
  { q: "Quelle est la durée de l'enquête de flagrant délit ?", options: ["24 heures", "48 heures", "8 jours", "15 jours"], correct: 2 },
  { q: "Comment s'appelle la décision rendue par le tribunal correctionnel ?", options: ["Un arrêt", "Une ordonnance", "Un jugement", "Un verdict"], correct: 2 },
  { q: "Quel article du Code de procédure pénale prévoit le contrôle d'identité sur réquisition du procureur ?", options: ["L'article 78-1", "L'article 78-2 alinéa 7", "L'article 62-2", "L'article 53"], correct: 1 },
  { q: "Combien de juges composent le tribunal correctionnel ?", options: ["1 juge", "2 juges", "3 juges", "5 juges"], correct: 2 },
  { q: "Quel est l'élément qui N'EST PAS un élément constitutif d'une infraction ?", options: ["Élément légal", "Élément matériel", "Élément moral", "Élément financier"], correct: 3 },
  { q: "Quel grade correspond à l'insigne d'un galon doré ?", options: ["Gardien de la paix", "Brigadier", "Brigadier-chef", "Major"], correct: 2 },
  { q: "Que signifie l'abréviation O.P.J. ?", options: ["Officier de Police Judiciaire", "Ordre de Poursuite Judiciaire", "Officier Principal de Justice", "Opération de Police Judiciaire"], correct: 0 },
  { q: "Quelle lettre de l'alphabet OTAN correspond au mot \"Foxtrot\" ?", options: ["E", "F", "G", "P"], correct: 1 },
  { q: "La garde à vue est une mesure de :", options: ["Rétention administrative", "Rétention judiciaire", "Rétention civile", "Rétention préventive"], correct: 1 },
  { q: "Quel est le sigle de la Police aux Frontières ?", options: ["P.A.F.", "P.J.", "B.A.C.", "C.R.S."], correct: 0 },
  { q: "Un mandat d'arrêt est délivré par :", options: ["Le préfet", "Le maire", "Un magistrat", "Un OPJ"], correct: 2 },
  { q: "Que signifie le sigle B.A.C. ?", options: ["Brigade Anti-Criminalité", "Bureau d'Aide aux Citoyens", "Brigade d'Assistance et de Contrôle", "Bureau d'Administration Centrale"], correct: 0 },
  { q: "Quelle lettre de l'alphabet OTAN correspond au mot \"Whiskey\" ?", options: ["V", "W", "X", "U"], correct: 1 },
  { q: "Combien de temps dure la garde à vue de droit commun (renouvellement compris) ?", options: ["24 heures", "48 heures", "72 heures", "96 heures"], correct: 1 },
  { q: "Que signifie le sigle C.R.S. ?", options: ["Compagnies Républicaines de Sécurité", "Corps Régional de Sécurité", "Compagnie de Renseignement et Surveillance", "Centre de Réponse et Secours"], correct: 0 },
  { q: "Quel est le grade juste au-dessus de Gardien de la paix ?", options: ["Brigadier", "Brigadier-chef", "Major", "Lieutenant"], correct: 0 },
  { q: "Que signifie le sigle D.G.P.N. ?", options: ["Direction Générale de la Police Nationale", "Département de Gestion du Personnel National", "Direction Générale du Personnel National", "Direction de la Gendarmerie et Police Nationale"], correct: 0 },
  { q: "Quelle lettre de l'alphabet OTAN correspond au mot \"Charlie\" ?", options: ["A", "B", "C", "K"], correct: 2 },
  { q: "Un flagrant délit peut être constaté jusqu'à combien de temps après les faits ?", options: ["Immédiatement uniquement", "1 heure", "Un temps très voisin de l'action", "24 heures"], correct: 2 },
  { q: "Que signifie le sigle P.J. dans le contexte policier ?", options: ["Police Judiciaire", "Procureur de Justice", "Police de Justice", "Poursuite Judiciaire"], correct: 0 },
  { q: "Quel tribunal juge les délits ?", options: ["Le tribunal de police", "Le tribunal correctionnel", "La cour d'assises", "Le tribunal administratif"], correct: 1 },
  { q: "Que signifie le sigle B.R.I. ?", options: ["Brigade de Recherche et d'Intervention", "Bureau du Renseignement Intérieur", "Brigade Régionale d'Investigation", "Bureau de Répression et Investigation"], correct: 0 },
  { q: "Quelle lettre de l'alphabet OTAN correspond au mot \"Sierra\" ?", options: ["S", "Z", "C", "X"], correct: 0 },
  { q: "Qui dirige une enquête préliminaire ?", options: ["Le juge d'instruction", "Le procureur de la République", "Le préfet", "L'OPJ seul, sans contrôle"], correct: 1 },
  { q: "Que signifie le sigle S.D.P.J. ?", options: ["Sous-Direction de la Police Judiciaire", "Service Départemental de la Police Judiciaire", "Section Départementale de Protection Judiciaire", "Service de Défense et Protection Juridique"], correct: 1 },
  { q: "Quel grade correspond à l'échelon juste sous Commissaire ?", options: ["Commandant", "Capitaine", "Lieutenant", "Major"], correct: 0 },
  { q: "Que signifie le sigle O.C.R.V.P. ?", options: ["Office Central pour la Répression des Violences aux Personnes", "Organisation Centrale de Renseignement et Veille Policière", "Office Central de Recherche des Personnes Vulnérables", "Organisme de Contrôle et Répression des Violences Publiques"], correct: 0 },
  { q: "Quelle lettre de l'alphabet OTAN correspond au mot \"Tango\" ?", options: ["T", "D", "G", "N"], correct: 0 },
  { q: "Que signifie le sigle U.S.I.C. ?", options: ["Unité de Sécurisation et d'Intervention Ciblée", "Unité de Soutien et d'Intervention de la Circulation", "Union Syndicale des Inspecteurs et Commissaires", "Unité Spéciale d'Intervention et de Contrôle"], correct: 0 }
];

// ----------------------------------------------------------------------------
// QUESTIONS AUTO-GÉNÉRÉES depuis les vraies fiches du site (ALPHABET + ORGS).
// Générées automatiquement — si tu modifies l'alphabet ou les organisations
// dans quiz-cee1.html, demande une régénération de ce bloc pour rester synchro.
// ----------------------------------------------------------------------------
const QUESTIONS_FROM_SITE = [
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre A ?", options: ["Echo", "Alpha", "Victor", "Bravo"], correct: 1 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre B ?", options: ["Bravo", "Yankee", "Echo", "Foxtrot"], correct: 0 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre C ?", options: ["Charlie", "Delta", "Bravo", "Alpha"], correct: 0 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre D ?", options: ["X-ray", "Hotel", "Sierra", "Delta"], correct: 3 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre E ?", options: ["Tango", "Echo", "Alpha", "Juliett"], correct: 1 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre F ?", options: ["Echo", "Lima", "Foxtrot", "Juliett"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre G ?", options: ["Charlie", "Golf", "November", "Delta"], correct: 1 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre H ?", options: ["Papa", "Hotel", "Yankee", "Bravo"], correct: 1 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre I ?", options: ["Kilo", "Sierra", "India", "Victor"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre J ?", options: ["Bravo", "X-ray", "Juliett", "Charlie"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre K ?", options: ["Hotel", "Kilo", "Delta", "November"], correct: 1 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre L ?", options: ["Mike", "Foxtrot", "Lima", "Golf"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre M ?", options: ["Foxtrot", "Mike", "Uniform", "Victor"], correct: 1 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre N ?", options: ["Mike", "November", "Victor", "India"], correct: 1 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre O ?", options: ["Oscar", "Hotel", "Bravo", "Zulu"], correct: 0 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre P ?", options: ["Papa", "Charlie", "India", "Golf"], correct: 0 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre Q ?", options: ["Oscar", "Mike", "Quebec", "Victor"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre R ?", options: ["Hotel", "Yankee", "Romeo", "Sierra"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre S ?", options: ["Lima", "Sierra", "Tango", "Mike"], correct: 1 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre T ?", options: ["Zulu", "Bravo", "Tango", "Charlie"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre U ?", options: ["Uniform", "Tango", "November", "Whiskey"], correct: 0 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre V ?", options: ["Oscar", "Tango", "Victor", "Quebec"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre W ?", options: ["Victor", "Yankee", "Whiskey", "Delta"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre X ?", options: ["November", "Delta", "X-ray", "Juliett"], correct: 2 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre Y ?", options: ["Yankee", "X-ray", "Quebec", "India"], correct: 0 },
  { q: "Quel mot de l'alphabet OTAN correspond à la lettre Z ?", options: ["Quebec", "Zulu", "Uniform", "Juliett"], correct: 1 },
  { q: "Que signifie le sigle DGPN ?", options: ["Direction Générale de la Police Nationale", "Direction de l'Ordre Public et de la Circulation", "Direction de la Sécurité de Proximité de l'Agglomération Parisienne", "Direction Centrale du Recrutement et de la Formation de la Police Nationale"], correct: 0 },
  { q: "Que signifie le sigle DNPJ ?", options: ["Direction Nationale de la Police Judiciaire", "Préfecture de Police (Paris)", "Direction Générale de la Police Nationale", "Direction Nationale du Renseignement Territorial"], correct: 0 },
  { q: "Que signifie le sigle DNSP ?", options: ["Direction Régionale de la Police Judiciaire (Paris)", "Inspection Générale de la Police Nationale", "Direction Nationale de la Sécurité Publique", "Direction Nationale de la Police Judiciaire"], correct: 2 },
  { q: "Que signifie le sigle DNPAF ?", options: ["Direction Nationale de la Sécurité Publique", "Direction Nationale de la Police aux Frontières", "Direction Centrale des Compagnies Républicaines de Sécurité", "Direction de l'Ordre Public et de la Circulation"], correct: 1 },
  { q: "Que signifie le sigle DNRT ?", options: ["Direction Centrale du Recrutement et de la Formation de la Police Nationale", "Direction de la Coopération Internationale de Sécurité", "Direction de l'Ordre Public et de la Circulation", "Direction Nationale du Renseignement Territorial"], correct: 3 },
  { q: "Que signifie le sigle DCCRS ?", options: ["Direction Générale des Douanes et Droits Indirects", "Direction Centrale des Compagnies Républicaines de Sécurité", "Service de la Transformation Numérique", "Service de la Protection"], correct: 1 },
  { q: "Que signifie le sigle DCRFPN ?", options: ["Inspection Générale de la Police Nationale", "Direction Centrale du Recrutement et de la Formation de la Police Nationale", "Direction Nationale de la Police aux Frontières", "Direction Nationale de la Sécurité Publique"], correct: 1 },
  { q: "Que signifie le sigle DRHFS ?", options: ["Inspection Générale de la Police Nationale", "Direction des Ressources Humaines, des Finances et des Soutiens", "Direction Générale de la Police Nationale", "Direction Régionale de la Police Judiciaire (Paris)"], correct: 1 },
  { q: "Que signifie le sigle IGPN ?", options: ["Direction Nationale de la Sécurité Publique", "Inspection Générale de la Police Nationale", "Direction des Ressources Humaines, des Finances et des Soutiens", "Direction Nationale de la Police Judiciaire"], correct: 1 },
  { q: "Que signifie le sigle DCIS ?", options: ["Direction de la Coopération Internationale de Sécurité", "Inspection Générale de la Police Nationale", "Préfecture de Police (Paris)", "Pôle Judiciaire de la Gendarmerie Nationale"], correct: 0 },
  { q: "Que signifie le sigle STN ?", options: ["Direction Générale de la Sécurité Civile et de la Gestion des Crises", "Préfecture de Police (Paris)", "Service de la Transformation Numérique", "Direction Régionale de la Police Judiciaire (Paris)"], correct: 2 },
  { q: "Que signifie le sigle RAID ?", options: ["Direction Centrale du Recrutement et de la Formation de la Police Nationale", "Pôle Judiciaire de la Gendarmerie Nationale", "Direction Nationale de la Police aux Frontières", "Recherche, Assistance, Intervention, Dissuasion"], correct: 3 },
  { q: "Que signifie le sigle BRI ?", options: ["Direction Générale de la Sécurité Intérieure", "Brigade de Recherche et d'Intervention", "Direction Générale de la Sécurité Civile et de la Gestion des Crises", "Unité de Coordination de la Lutte AntiTerroriste"], correct: 1 },
  { q: "Que signifie le sigle SDLP ?", options: ["Brigade de Recherche et d'Intervention", "Service de la Protection", "Direction Nationale de la Police Judiciaire", "Direction Générale de la Sécurité Civile et de la Gestion des Crises"], correct: 1 },
  { q: "Que signifie le sigle UCLAT ?", options: ["Direction Générale de la Sécurité Intérieure", "Direction Centrale du Recrutement et de la Formation de la Police Nationale", "Unité de Coordination de la Lutte AntiTerroriste", "Direction de l'Ordre Public et de la Circulation"], correct: 2 },
  { q: "Que signifie le sigle DGSI ?", options: ["Direction des Ressources Humaines, des Finances et des Soutiens", "Direction Générale de la Sécurité Intérieure", "Unité de Coordination de la Lutte AntiTerroriste", "Inspection Générale de la Police Nationale"], correct: 1 },
  { q: "Que signifie le sigle PP ?", options: ["Groupe d'Intervention de la Gendarmerie Nationale", "Direction de l'Ordre Public et de la Circulation", "Préfecture de Police (Paris)", "Direction Nationale de la Police Judiciaire"], correct: 2 },
  { q: "Que signifie le sigle DSPAP ?", options: ["Direction Générale de la Sécurité Intérieure", "Service de la Protection", "Direction Centrale des Compagnies Républicaines de Sécurité", "Direction de la Sécurité de Proximité de l'Agglomération Parisienne"], correct: 3 },
  { q: "Que signifie le sigle DOPC ?", options: ["Direction de l'Ordre Public et de la Circulation", "Brigade de Recherche et d'Intervention", "Direction Centrale des Compagnies Républicaines de Sécurité", "Direction Nationale de la Police Judiciaire"], correct: 0 },
  { q: "Que signifie le sigle DRPJ ?", options: ["Direction de la Coopération Internationale de Sécurité", "Service de la Protection", "Unité de Coordination de la Lutte AntiTerroriste", "Direction Régionale de la Police Judiciaire (Paris)"], correct: 3 },
  { q: "Que signifie le sigle DGGN ?", options: ["Direction Générale de la Gendarmerie Nationale", "Direction Centrale du Recrutement et de la Formation de la Police Nationale", "Direction Nationale de la Police Judiciaire", "Direction de la Coopération Internationale de Sécurité"], correct: 0 },
  { q: "Que signifie le sigle GIGN ?", options: ["Groupe d'Intervention de la Gendarmerie Nationale", "Direction Générale de la Sécurité Intérieure", "Direction Nationale de la Police Judiciaire", "Direction de l'Ordre Public et de la Circulation"], correct: 0 },
  { q: "Que signifie le sigle PJGN ?", options: ["Direction Nationale de la Sécurité Publique", "Pôle Judiciaire de la Gendarmerie Nationale", "Direction Régionale de la Police Judiciaire (Paris)", "Direction Centrale des Compagnies Républicaines de Sécurité"], correct: 1 },
  { q: "Que signifie le sigle DGDDI ?", options: ["Direction Générale des Douanes et Droits Indirects", "Brigade de Recherche et d'Intervention", "Direction de l'Ordre Public et de la Circulation", "Direction Nationale de la Police aux Frontières"], correct: 0 },
  { q: "Que signifie le sigle DGSCGC ?", options: ["Direction Générale de la Sécurité Civile et de la Gestion des Crises", "Direction Régionale de la Police Judiciaire (Paris)", "Direction Nationale de la Sécurité Publique", "Service de la Protection"], correct: 0 }
];

// La banque complète = questions manuelles (procédure/CEE1) + fiches du site.
const ALL_QUESTIONS_MP = QUESTIONS_MP.concat(QUESTIONS_FROM_SITE);

const QUESTION_TIME_MS = 15000;   // 15 secondes par question
const DUEL_QUESTION_COUNT = 10;
const MAX_SPEED_BONUS = 50;       // bonus max si on répond instantanément
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

function pickQuestionOrder(count) {
  const indices = ALL_QUESTIONS_MP.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, Math.min(count, indices.length));
}

function publicPlayerList(room) {
  return Array.from(room.players.values()).map(p => ({ pseudo: p.pseudo, score: p.score, connected: p.connected }));
}

function top5(room) {
  return Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(p => ({ pseudo: p.pseudo, score: p.score }));
}

function finalPodium(room) {
  return Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ pseudo: p.pseudo, score: p.score, rank: i + 1 }));
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
  const question = ALL_QUESTIONS_MP[qIndex];
  room.currentQuestionStartedAt = Date.now();
  room.answersThisQuestion = new Map(); // socketId -> { correct, timeMs }

  io.to(room.code).emit('question', {
    index: room.currentQuestionIndex,
    total: totalQuestions,
    text: question.q,
    options: question.options,
    timeLimitMs: QUESTION_TIME_MS
  });

  if (room.questionTimer) clearTimeout(room.questionTimer);
  room.questionTimer = setTimeout(() => {
    revealAndAdvance(room);
  }, QUESTION_TIME_MS + 300); // petite marge réseau
}

function revealAndAdvance(room) {
  const qIndex = room.questionOrder[room.currentQuestionIndex];
  const question = ALL_QUESTIONS_MP[qIndex];

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
  socket.on('create-duel', ({ pseudo, uid }, callback) => {
    if (!canCreateRoom(socket.id)) {
      callback({ ok: false, error: 'Trop de salons créés récemment — attends quelques minutes.' });
      return;
    }
    pseudo = sanitizePseudo(pseudo);
    const code = generateRoomCode();
    const room = {
      code,
      mode: 'duel',
      creatorSocketId: socket.id,
      players: new Map(),
      status: 'lobby',
      questionOrder: pickQuestionOrder(DUEL_QUESTION_COUNT)
    };
    room.players.set(socket.id, { pseudo: pseudo || 'Joueur', uid: uid || null, score: 0, connected: true });
    rooms.set(code, room);

    socket.join(code);
    callback({ ok: true, code });
    io.to(code).emit('players-update', publicPlayerList(room));
  });

  // ---- Créer une Bataille de Section (Premium uniquement) ----
  socket.on('create-battle', async ({ pseudo, idToken, uid }, callback) => {
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
    const code = generateRoomCode();
    const room = {
      code,
      mode: 'battle',
      creatorSocketId: socket.id,
      players: new Map(),
      status: 'lobby',
      questionOrder: pickQuestionOrder(ALL_QUESTIONS_MP.length) // toutes les questions dispo
    };
    room.players.set(socket.id, { pseudo: pseudo || 'Joueur', uid: uid || null, score: 0, connected: true });
    rooms.set(code, room);

    socket.join(code);
    callback({ ok: true, code });
    io.to(code).emit('players-update', publicPlayerList(room));
  });

  // ---- Rejoindre un salon (duel OU bataille) avec un code — toujours gratuit ----
  socket.on('join-room', ({ code, pseudo, uid }, callback) => {
    const room = rooms.get(code);
    if (!room) { callback({ ok: false, error: 'Code invalide — ce salon n\'existe pas.' }); return; }
    if (room.status !== 'lobby') { callback({ ok: false, error: 'Cette partie a déjà commencé.' }); return; }
    if (room.mode === 'duel' && room.players.size >= 2) {
      callback({ ok: false, error: 'Ce duel est déjà complet (2 joueurs).' });
      return;
    }
    if (room.mode === 'battle' && room.players.size >= 60) {
      callback({ ok: false, error: 'Ce salon est complet (60 joueurs maximum).' });
      return;
    }
    pseudo = sanitizePseudo(pseudo);

    room.players.set(socket.id, { pseudo: pseudo || 'Joueur', uid: uid || null, score: 0, connected: true });
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

    io.to(code).emit('game-starting', { countdownMs: 3000 });
    setTimeout(() => startGame(room), 3000);
  });

  // ---- Un joueur répond à la question en cours ----
  socket.on('submit-answer', ({ code, optionIndex }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'in-progress') return;
    if (room.answersThisQuestion.has(socket.id)) return; // une seule réponse par question

    const qIndex = room.questionOrder[room.currentQuestionIndex];
    const question = ALL_QUESTIONS_MP[qIndex];
    const elapsedMs = Date.now() - room.currentQuestionStartedAt;
    const isCorrect = optionIndex === question.correct;

    let pointsEarned = 0;
    if (isCorrect) {
      const timeRemainingMs = Math.max(0, QUESTION_TIME_MS - elapsedMs);
      const speedBonus = Math.round((timeRemainingMs / QUESTION_TIME_MS) * MAX_SPEED_BONUS);
      pointsEarned = POINTS_PER_CORRECT + speedBonus;
    }

    room.answersThisQuestion.set(socket.id, { correct: isCorrect, elapsedMs });
    const player = room.players.get(socket.id);
    if (player) player.score += pointsEarned;

    socket.emit('answer-ack', { correct: isCorrect, pointsEarned, yourScore: player ? player.score : 0 });

    // Si tout le monde a répondu, on n'attend pas la fin du chrono.
    const connectedCount = Array.from(room.players.values()).filter(p => p.connected).length;
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
    room.players.forEach(p => { p.score = 0; });
    room.status = 'lobby';
    room.questionOrder = pickQuestionOrder(room.mode === 'duel' ? DUEL_QUESTION_COUNT : ALL_QUESTIONS_MP.length);
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
