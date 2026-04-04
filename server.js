/**
 * TimeSwap — Backend API (Node.js / Express)
 * Endpoints REST + Stripe + Firebase Auth + SendGrid + Gamification
 * 
 * Stack: Express · Firebase Admin · Stripe · SendGrid · WebRTC Signaling
 * Commission: 15% sur chaque transaction
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { body, param, validationResult } = require('express-validator');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail = require('@sendgrid/mail');
const http = require('http');
const { Server } = require('socket.io');

// ─── INIT ─────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_URL } });

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.firestore();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const COMMISSION_RATE = 0.15; // 15%
const PREMIUM_FEE = 2.00;     // €2 par session premium

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

// ─── MIDDLEWARE: AUTH ──────────────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
};

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// ─── AUTH ──────────────────────────────────────────────────────────────────────

/**
 * POST /auth/signup
 * Crée un compte Firebase + document Firestore user
 */
app.post('/auth/signup', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').trim().notEmpty(),
  body('role').isIn(['buyer', 'seller', 'both']),
], validate, async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    const userRecord = await admin.auth().createUser({ email, password, displayName: name });

    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      name,
      email,
      role,
      emailVerified: false,
      premium: false,
      rating: 0,
      totalReviews: 0,
      totalSessions: 0,
      totalEarnings: 0,
      walletBalance: 0,
      badges: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Email de bienvenue
    await sendEmail(email, 'd-welcome-template', { name });

    res.status(201).json({ uid: userRecord.uid, message: 'Compte créé avec succès' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /auth/login
 * Retourne un custom token Firebase (le client l'échange contre un ID token)
 */
app.post('/auth/login', [
  body('uid').notEmpty(),
], validate, authenticate, async (req, res) => {
  const user = await db.collection('users').doc(req.user.uid).get();
  res.json({ user: user.data() });
});

// ─── OFFERS ───────────────────────────────────────────────────────────────────

/**
 * GET /offers
 * Liste les offres avec filtres : category, duration, minPrice, maxPrice, premium, search
 */
app.get('/offers', async (req, res) => {
  try {
    const { category, duration, minPrice, maxPrice, premium, search, limit = 20, offset = 0 } = req.query;
    let query = db.collection('offers').where('active', '==', true);

    if (category) query = query.where('category', '==', category);
    if (premium) query = query.where('premium', '==', true);
    query = query.orderBy('premium', 'desc').orderBy('createdAt', 'desc');

    const snap = await query.limit(parseInt(limit)).get();
    let offers = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Filtres côté serveur
    if (duration) offers = offers.filter(o => o.durations.includes(parseInt(duration)));
    if (minPrice) offers = offers.filter(o => o.basePrice >= parseFloat(minPrice));
    if (maxPrice) offers = offers.filter(o => o.basePrice <= parseFloat(maxPrice));
    if (search) {
      const s = search.toLowerCase();
      offers = offers.filter(o =>
        o.title.toLowerCase().includes(s) || o.description.toLowerCase().includes(s)
      );
    }

    res.json({ offers, total: offers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /offers
 * Crée une nouvelle offre (vendeur authentifié)
 */
app.post('/offers', authenticate, [
  body('title').trim().isLength({ min: 5, max: 100 }),
  body('description').trim().isLength({ min: 20, max: 1000 }),
  body('category').isIn(['Coaching', 'Fun', 'Créatif', 'Services']),
  body('durations').isArray({ min: 1 }),
  body('prices').isObject(),
  body('availability').isArray(),
], validate, async (req, res) => {
  try {
    const { title, description, category, durations, prices, availability, premium } = req.body;
    const uid = req.user.uid;

    const user = await db.collection('users').doc(uid).get();
    if (!user.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const offerRef = db.collection('offers').doc();
    const basePrice = Math.min(...durations.map(d => prices[d] || 0));

    await offerRef.set({
      id: offerRef.id,
      sellerId: uid,
      sellerName: user.data().name,
      sellerRating: user.data().rating,
      title,
      description,
      category,
      durations,
      prices,
      availability,
      premium: !!premium,
      basePrice,
      active: true,
      totalBookings: 0,
      rating: 0,
      totalReviews: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ offerId: offerRef.id, message: 'Offre publiée avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /offers/:id
 */
app.get('/offers/:id', async (req, res) => {
  const offer = await db.collection('offers').doc(req.params.id).get();
  if (!offer.exists) return res.status(404).json({ error: 'Offre introuvable' });
  res.json({ id: offer.id, ...offer.data() });
});

/**
 * PATCH /offers/:id
 * Mise à jour offre (vendeur propriétaire uniquement)
 */
app.patch('/offers/:id', authenticate, async (req, res) => {
  const offer = await db.collection('offers').doc(req.params.id).get();
  if (!offer.exists) return res.status(404).json({ error: 'Offre introuvable' });
  if (offer.data().sellerId !== req.user.uid) return res.status(403).json({ error: 'Accès refusé' });

  const allowed = ['title', 'description', 'durations', 'prices', 'availability', 'active', 'premium'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  await db.collection('offers').doc(req.params.id).update(updates);
  res.json({ message: 'Offre mise à jour' });
});

/**
 * DELETE /offers/:id
 */
app.delete('/offers/:id', authenticate, async (req, res) => {
  const offer = await db.collection('offers').doc(req.params.id).get();
  if (!offer.exists) return res.status(404).json({ error: 'Offre introuvable' });
  if (offer.data().sellerId !== req.user.uid) return res.status(403).json({ error: 'Accès refusé' });
  await db.collection('offers').doc(req.params.id).update({ active: false });
  res.json({ message: 'Offre désactivée' });
});

// ─── SESSIONS ─────────────────────────────────────────────────────────────────

/**
 * POST /sessions
 * Réservation d'une session + pré-autorisation Stripe
 */
app.post('/sessions', authenticate, [
  body('offerId').notEmpty(),
  body('duration').isIn([15, 30, 60]),
  body('scheduledAt').isISO8601(),
  body('paymentMethodId').notEmpty(),
], validate, async (req, res) => {
  const { offerId, duration, scheduledAt, paymentMethodId } = req.body;
  const buyerId = req.user.uid;

  try {
    const offer = await db.collection('offers').doc(offerId).get();
    if (!offer.exists || !offer.data().active) return res.status(404).json({ error: 'Offre introuvable' });

    const offerData = offer.data();
    const pricePerSession = offerData.prices[duration] || offerData.basePrice;
    const commission = Math.round(pricePerSession * COMMISSION_RATE * 100) / 100;
    const premiumFee = offerData.premium ? PREMIUM_FEE : 0;
    const totalAmount = pricePerSession + commission + premiumFee;

    // Pré-autorisation Stripe (capture: false)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100),
      currency: 'eur',
      payment_method: paymentMethodId,
      capture_method: 'manual', // Pré-autorisation uniquement
      confirm: true,
      metadata: {
        offerId,
        buyerId,
        sellerId: offerData.sellerId,
        duration: String(duration),
        commission: String(commission),
      },
    });

    const sessionRef = db.collection('sessions').doc();
    await sessionRef.set({
      id: sessionRef.id,
      offerId,
      buyerId,
      sellerId: offerData.sellerId,
      sellerName: offerData.sellerName,
      offerTitle: offerData.title,
      duration,
      scheduledAt: new Date(scheduledAt),
      status: 'pending',
      amount: pricePerSession,
      commission,
      premiumFee,
      totalAmount,
      paymentIntentId: paymentIntent.id,
      zoomLink: null,
      webrtcRoomId: sessionRef.id,
      rating: null,
      review: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notifications
    const buyer = await db.collection('users').doc(buyerId).get();
    await sendEmail(buyer.data().email, 'd-booking-confirmed', {
      sellerName: offerData.sellerName,
      offerTitle: offerData.title,
      scheduledAt,
      sessionId: sessionRef.id,
    });

    const seller = await db.collection('users').doc(offerData.sellerId).get();
    await sendEmail(seller.data().email, 'd-new-booking', {
      buyerName: buyer.data().name,
      offerTitle: offerData.title,
      scheduledAt,
    });

    res.status(201).json({
      sessionId: sessionRef.id,
      paymentIntentId: paymentIntent.id,
      message: 'Session réservée avec succès',
      webrtcRoomId: sessionRef.id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /sessions/:id/complete
 * Finalise la session → capture paiement + release vendeur + gamification
 */
app.patch('/sessions/:id/complete', authenticate, async (req, res) => {
  const session = await db.collection('sessions').doc(req.params.id).get();
  if (!session.exists) return res.status(404).json({ error: 'Session introuvable' });

  const s = session.data();
  if (s.status !== 'pending' && s.status !== 'active') {
    return res.status(400).json({ error: 'Statut invalide' });
  }
  if (s.sellerId !== req.user.uid && s.buyerId !== req.user.uid) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    // Capture du paiement Stripe
    await stripe.paymentIntents.capture(s.paymentIntentId);

    // Crédit vendeur (montant - commission)
    const sellerPayout = s.amount - s.commission;
    await db.collection('users').doc(s.sellerId).update({
      walletBalance: admin.firestore.FieldValue.increment(sellerPayout),
      totalEarnings: admin.firestore.FieldValue.increment(sellerPayout),
      totalSessions: admin.firestore.FieldValue.increment(1),
    });

    await db.collection('sessions').doc(req.params.id).update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Enregistrement transaction
    await db.collection('transactions').add({
      sessionId: req.params.id,
      buyerId: s.buyerId,
      sellerId: s.sellerId,
      amount: s.amount,
      commission: s.commission,
      sellerPayout,
      type: 'session_complete',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Gamification
    await checkAndAwardBadges(s.sellerId);

    // Notifier vendeur
    const seller = await db.collection('users').doc(s.sellerId).get();
    await sendEmail(seller.data().email, 'd-session-completed', {
      offerTitle: s.offerTitle,
      amount: sellerPayout.toFixed(2),
    });

    res.json({ message: 'Session complétée, paiement libéré' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /sessions/:id/cancel
 * Annule et rembourse (si > 24h avant)
 */
app.patch('/sessions/:id/cancel', authenticate, async (req, res) => {
  const session = await db.collection('sessions').doc(req.params.id).get();
  if (!session.exists) return res.status(404).json({ error: 'Session introuvable' });
  const s = session.data();

  const hoursUntil = (new Date(s.scheduledAt.toDate()) - Date.now()) / 3600000;
  const fullRefund = hoursUntil > 24;

  try {
    if (fullRefund) {
      await stripe.paymentIntents.cancel(s.paymentIntentId);
    } else {
      // Capture partielle (commission retenue)
      await stripe.paymentIntents.capture(s.paymentIntentId, {
        amount_to_capture: Math.round(s.commission * 100),
      });
    }

    await db.collection('sessions').doc(req.params.id).update({
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      fullRefund,
    });

    res.json({ message: fullRefund ? 'Remboursement complet effectué' : 'Commission retenue' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /sessions/:id/review
 * Note + commentaire post-session
 */
app.post('/sessions/:id/review', authenticate, [
  body('rating').isInt({ min: 1, max: 5 }),
  body('comment').optional().trim().isLength({ max: 500 }),
], validate, async (req, res) => {
  const { rating, comment } = req.body;
  const session = await db.collection('sessions').doc(req.params.id).get();
  if (!session.exists) return res.status(404).json({ error: 'Session introuvable' });
  const s = session.data();
  if (s.buyerId !== req.user.uid) return res.status(403).json({ error: 'Accès refusé' });
  if (s.status !== 'completed') return res.status(400).json({ error: 'Session non terminée' });

  await db.collection('sessions').doc(req.params.id).update({ rating, review: comment });

  // Recalcul note vendeur
  const sellerSessions = await db.collection('sessions')
    .where('sellerId', '==', s.sellerId)
    .where('status', '==', 'completed')
    .where('rating', '!=', null)
    .get();

  const ratings = sellerSessions.docs.map(d => d.data().rating);
  const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;

  await db.collection('users').doc(s.sellerId).update({
    rating: Math.round(avgRating * 10) / 10,
    totalReviews: ratings.length,
  });

  await db.collection('offers').doc(s.offerId).update({
    rating: Math.round(avgRating * 10) / 10,
    totalReviews: admin.firestore.FieldValue.increment(1),
  });

  res.json({ message: 'Avis enregistré' });
});

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────

/**
 * GET /transactions
 */
app.get('/transactions', authenticate, async (req, res) => {
  const snap = await db.collection('transactions')
    .where('sellerId', '==', req.user.uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  res.json({ transactions: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

/**
 * POST /transactions/withdraw
 * Virement Stripe Connect vers compte vendeur
 */
app.post('/transactions/withdraw', authenticate, [
  body('amount').isFloat({ min: 10 }),
], validate, async (req, res) => {
  const user = await db.collection('users').doc(req.user.uid).get();
  const { walletBalance, stripeAccountId } = user.data();

  if (req.body.amount > walletBalance) {
    return res.status(400).json({ error: 'Solde insuffisant' });
  }
  if (!stripeAccountId) {
    return res.status(400).json({ error: 'Compte Stripe non configuré' });
  }

  const transfer = await stripe.transfers.create({
    amount: Math.round(req.body.amount * 100),
    currency: 'eur',
    destination: stripeAccountId,
  });

  await db.collection('users').doc(req.user.uid).update({
    walletBalance: admin.firestore.FieldValue.increment(-req.body.amount),
  });

  await db.collection('transactions').add({
    sellerId: req.user.uid,
    type: 'withdrawal',
    amount: req.body.amount,
    stripeTransferId: transfer.id,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ message: 'Virement initié', transferId: transfer.id });
});

// ─── USERS ─────────────────────────────────────────────────────────────────────

/**
 * GET /users/:id
 */
app.get('/users/:id', async (req, res) => {
  const user = await db.collection('users').doc(req.params.id).get();
  if (!user.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const { walletBalance, stripeAccountId, ...publicData } = user.data();
  res.json(publicData);
});

/**
 * GET /users/:id/badges
 */
app.get('/users/:id/badges', async (req, res) => {
  const user = await db.collection('users').doc(req.params.id).get();
  if (!user.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ badges: user.data().badges || [] });
});

/**
 * PATCH /users/me
 */
app.patch('/users/me', authenticate, [
  body('name').optional().trim().isLength({ min: 2 }),
  body('email').optional().isEmail(),
], validate, async (req, res) => {
  const allowed = ['name', 'bio', 'avatar'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  await db.collection('users').doc(req.user.uid).update(updates);
  res.json({ message: 'Profil mis à jour' });
});

// ─── STRIPE WEBHOOKS ──────────────────────────────────────────────────────────

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.payment_failed': {
      const { metadata } = event.data.object;
      const session = await db.collection('sessions')
        .where('paymentIntentId', '==', event.data.object.id).limit(1).get();
      if (!session.empty) {
        await session.docs[0].ref.update({ status: 'payment_failed' });
      }
      break;
    }
    case 'transfer.created': {
      console.log('Transfer created:', event.data.object.id);
      break;
    }
  }
  res.json({ received: true });
});

// ─── GAMIFICATION ─────────────────────────────────────────────────────────────

const BADGES = [
  { id: 'first_session', name: 'Première session', icon: '🌟', condition: u => u.totalSessions >= 1 },
  { id: 'five_sessions', name: '5 sessions', icon: '🔥', condition: u => u.totalSessions >= 5 },
  { id: 'ten_sessions', name: '10 sessions', icon: '💎', condition: u => u.totalSessions >= 10 },
  { id: 'twenty_five_sessions', name: '25 sessions', icon: '🚀', condition: u => u.totalSessions >= 25 },
  { id: 'fifty_sessions', name: '50 sessions', icon: '💯', condition: u => u.totalSessions >= 50 },
  { id: 'five_star', name: 'Note 5 étoiles', icon: '⭐', condition: u => u.rating >= 4.9 && u.totalReviews >= 5 },
  { id: 'top_seller', name: 'Top vendeur', icon: '👑', condition: u => u.totalEarnings >= 1000 },
];

async function checkAndAwardBadges(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  const user = userDoc.data();
  const existing = user.badges || [];

  const newBadges = BADGES.filter(b =>
    !existing.includes(b.id) && b.condition(user)
  );

  if (newBadges.length > 0) {
    await db.collection('users').doc(userId).update({
      badges: admin.firestore.FieldValue.arrayUnion(...newBadges.map(b => b.id)),
    });

    // Notifier nouveaux badges
    const seller = await db.collection('users').doc(userId).get();
    for (const badge of newBadges) {
      await sendEmail(seller.data().email, 'd-new-badge', {
        badgeName: badge.name,
        badgeIcon: badge.icon,
      });
    }
  }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

async function sendEmail(to, templateId, dynamicData) {
  try {
    await sgMail.send({
      to,
      from: { email: 'noreply@timeswap.io', name: 'TimeSwap' },
      templateId,
      dynamicTemplateData: dynamicData,
    });
  } catch (err) {
    console.error('SendGrid error:', err.response?.body?.errors);
  }
}

// Push notification via Firebase Cloud Messaging
async function sendPushNotification(userId, title, body, data = {}) {
  const user = await db.collection('users').doc(userId).get();
  const { fcmToken } = user.data();
  if (!fcmToken) return;

  await admin.messaging().send({
    token: fcmToken,
    notification: { title, body },
    data,
  });
}

// ─── WEBRTC SIGNALING (Socket.io) ─────────────────────────────────────────────

io.on('connection', (socket) => {
  const { roomId, userId } = socket.handshake.query;
  if (!roomId) return socket.disconnect();

  socket.join(roomId);
  socket.to(roomId).emit('peer-joined', { userId });

  socket.on('signal', (data) => {
    socket.to(roomId).emit('signal', { ...data, from: userId });
  });

  socket.on('disconnect', () => {
    socket.to(roomId).emit('peer-left', { userId });
  });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date() }));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`TimeSwap API → http://localhost:${PORT}`));

module.exports = { app, server };
