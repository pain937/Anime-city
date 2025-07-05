
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: 'animecitysecret',
  resave: false,
  saveUninitialized: false,
}));

const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT,
    nickname TEXT,
    warnings INTEGER DEFAULT 0,
    alerts INTEGER DEFAULT 0,
    hasCard INTEGER DEFAULT 0,
    billyCurrent INTEGER DEFAULT 100000,
    billyNext INTEGER DEFAULT 100000
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fromUser INTEGER,
    toUser INTEGER,
    amount INTEGER,
    date TEXT,
    FOREIGN KEY(fromUser) REFERENCES users(id),
    FOREIGN KEY(toUser) REFERENCES users(id)
  )`);

  const users = [
    ['admin', 'admin123', 'admin', 'الجادج'],
    ['mod', 'mod123', 'moderator', 'المشرف'],
    ['user1', 'user123', 'user', 'عضو 1'],
    ['user2', 'user234', 'user', 'عضو 2'],
  ];
  const stmt = db.prepare("INSERT OR IGNORE INTO users (username, password, role, nickname) VALUES (?, ?, ?, ?)");
  users.forEach(u => stmt.run(u));
  stmt.finalize();
});

function checkAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function loadUser(req, res, next) {
  if (!req.session.userId) return next();
  db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err) return next(err);
    req.user = user;
    next();
  });
}

app.use(loadUser);

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
    if (err) return res.render('login', { error: 'خطأ في قاعدة البيانات' });
    if (!user) return res.render('login', { error: 'اسم المستخدم أو كلمة السر غير صحيحة' });

    req.session.userId = user.id;
    res.redirect('/');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/', checkAuth, (req, res) => {
  if (req.user.role === 'admin' || req.user.role === 'moderator') {
    db.all('SELECT * FROM users', (err, users) => {
      if (err) return res.send('خطأ في جلب المستخدمين');
      db.all(`SELECT transfers.*, u1.nickname AS fromNick, u2.nickname AS toNick 
              FROM transfers 
              LEFT JOIN users u1 ON transfers.fromUser = u1.id 
              LEFT JOIN users u2 ON transfers.toUser = u2.id 
              ORDER BY date DESC`, (err2, transfers) => {
        if (err2) return res.send('خطأ في جلب التحويلات');
        res.render('admin', { user: req.user, users, transfers });
      });
    });
  } else {
    db.all('SELECT transfers.*, u1.nickname AS fromNick, u2.nickname AS toNick FROM transfers LEFT JOIN users u1 ON transfers.fromUser = u1.id LEFT JOIN users u2 ON transfers.toUser = u2.id WHERE fromUser = ? OR toUser = ? ORDER BY date DESC', [req.user.id, req.user.id], (err, transfers) => {
      if (err) return res.send('خطأ في جلب التحويلات');
      res.render('user', { user: req.user, transfers });
    });
  }
});

app.post('/users/create', checkAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') return res.status(403).send('غير مصرح');
  const { username, password, role, nickname } = req.body;
  db.run('INSERT INTO users (username, password, role, nickname) VALUES (?, ?, ?, ?)', [username, password, role, nickname], function(err) {
    if (err) return res.send('خطأ في إنشاء المستخدم');
    res.redirect('/');
  });
});

app.post('/users/:id/edit', checkAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') return res.status(403).send('غير مصرح');
  const id = req.params.id;
  const { nickname, warnings, alerts, hasCard, billyCurrent, billyNext } = req.body;
  db.run(`UPDATE users SET nickname = ?, warnings = ?, alerts = ?, hasCard = ?, billyCurrent = ?, billyNext = ? WHERE id = ?`,
    [nickname, parseInt(warnings), parseInt(alerts), hasCard === '1' ? 1 : 0, parseInt(billyCurrent), parseInt(billyNext), id],
    (err) => {
      if (err) return res.send('خطأ في تعديل المستخدم');
      res.redirect('/');
    });
});

app.post('/users/:id/delete', checkAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') return res.status(403).send('غير مصرح');
  const id = req.params.id;
  db.run('DELETE FROM users WHERE id = ?', [id], (err) => {
    if (err) return res.send('خطأ في حذف الحساب');
    res.redirect('/');
  });
});

app.post('/transfer', checkAuth, (req, res) => {
  const { toUsername, amount } = req.body;
  const amt = parseInt(amount);
  if (isNaN(amt) || amt <= 0 || amt > 500000) return res.send('المبلغ غير صالح أو تجاوز الحد اليومي');

  db.get('SELECT * FROM users WHERE username = ?', [toUsername], (err, toUser) => {
    if (err || !toUser) return res.send('المستخدم المستلم غير موجود');
    if (req.user.billyCurrent < amt) return res.send('رصيد غير كافي');

    const date = new Date().toISOString();
    db.run('BEGIN TRANSACTION');
    db.run('UPDATE users SET billyCurrent = billyCurrent - ? WHERE id = ?', [amt, req.user.id]);
    db.run('UPDATE users SET billyCurrent = billyCurrent + ? WHERE id = ?', [amt, toUser.id]);
    db.run('INSERT INTO transfers (fromUser, toUser, amount, date) VALUES (?, ?, ?, ?)', [req.user.id, toUser.id, amt, date], (err) => {
      if (err) return db.run('ROLLBACK', () => res.send('فشل التحويل'));
      db.run('COMMIT');
      res.redirect('/');
    });
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Anime City شغّال على المنفذ ${port}`);
});
